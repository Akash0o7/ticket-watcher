import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const HOME_URL = "https://ticketgenie.in/";
const EVENT_URL =
  process.env.EVENT_URL || "https://ticketgenie.in/ticket/india-vs-west-indies-5th-t20i-match-bengaluru-Oct17-2026/";
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const INTERVAL_MS = Number(process.env.INTERVAL_SECONDS || 60) * 1000;
const QTY = Number(process.env.QTY || 4);
const MAX_PRICE = Number(process.env.MAX_PRICE || 1500); // never pick a category dearer than this
const DRY_RUN = process.env.DRY_RUN === "1"; // go through every step but stop before paying
const HEADLESS = process.env.HEADLESS === "1";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5);
const APPROVAL_WAIT_MS = 10 * 60 * 1000;
const REMOTE_VIEW_URL = process.env.REMOTE_VIEW_URL || ""; // phone-accessible link to the live browser (noVNC)
const HUMAN_WAIT_MS = Number(process.env.HUMAN_WAIT_MINUTES || 5) * 60 * 1000;

const PROFILE = {
  name: process.env.BUYER_NAME || "",
  email: process.env.BUYER_EMAIL || "",
  phone: process.env.BUYER_PHONE || "",
};

const BLOCKERS = ["sold out", "coming soon", "notify me", "registrations closed"];
const BUY_WORDS = ["book now", "buy tickets", "buy now", "get tickets", "book tickets"];
const NEXT_WORDS = /^(continue|proceed|next|checkout|book|book now|buy|buy now|confirm|proceed to pay|place order|pay now|pay)\b/i;

mkdirSync("shots", { recursive: true });
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) =>
  page.screenshot({ path: `shots/${Date.now()}-${name}.png`, fullPage: true }).catch(() => {});

async function notify(title, message, url = HOME_URL, priority = "urgent") {
  log(`${title}: ${message}`);
  if (!NTFY_TOPIC) return;
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: "ticket", Click: url },
    body: message,
  }).catch((e) => log(`ntfy failed: ${e.message}`));
}

async function bodyText(page) {
  return (await page.innerText("body").catch(() => "")).toLowerCase();
}

async function findEventUrl(page) {
  if (EVENT_URL) return EVENT_URL;
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const links = await page.$$eval("a[href]", (as) =>
    as.map((a) => ({ href: a.href, text: (a.innerText || "") + " " + a.href }))
  );
  const hit = links.find((l) => {
    const t = l.text.toLowerCase();
    return t.includes("west indies") && (t.includes("bengaluru") || t.includes("bangalore"));
  });
  return hit?.href ?? null;
}

async function isLive(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  const text = await bodyText(page);
  const cityOk = text.includes("bengaluru") || text.includes("bangalore");
  if (!cityOk || !text.includes("west indies")) return false;
  if (BLOCKERS.some((b) => text.includes(b))) return false;
  return BUY_WORDS.some((b) => text.includes(b));
}

// Sends a screenshot of the current page to the phone so you can see what the bot sees.
async function notifyShot(page, title, message, priority = "urgent") {
  log(`${title}: ${message}`);
  if (!NTFY_TOPIC) return;
  const image = await page.screenshot().catch(() => null);
  if (!image) return notify(title, message, REMOTE_VIEW_URL || page.url(), priority);
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: "PUT",
    headers: {
      Filename: "page.png",
      Title: title,
      Message: message,
      Priority: priority,
      Tags: "warning",
      Click: REMOTE_VIEW_URL || page.url(),
    },
    body: image,
  }).catch((e) => log(`ntfy failed: ${e.message}`));
}

const pageFingerprint = async (page) => `${page.url()}|${(await bodyText(page)).slice(0, 2000)}`;

// Pauses the script and lets you act in the live browser (captcha, expired login, odd popup).
// Returns once the page changes or the wait runs out.
async function askHuman(page, title, reason) {
  const hint = REMOTE_VIEW_URL ? "Tap this alert to open the live browser." : "Open the booking window.";
  await notifyShot(page, title, `${reason} ${hint}`);
  const before = await pageFingerprint(page);
  const deadline = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await pageFingerprint(page)) !== before) {
      log("Page changed after human help, continuing.");
      return true;
    }
  }
  return false;
}

const CAPTCHA_SELECTOR =
  "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], iframe[src*='captcha']";

// The captcha is solved by you, never by the script.
async function waitIfCaptcha(page) {
  const hasCaptcha = async () =>
    (await page.locator(CAPTCHA_SELECTOR).count()) > 0 ||
    /verify you are human|i'm not a robot|security check/.test(await bodyText(page));
  if (!(await hasCaptcha())) return;
  await notifyShot(page, "CAPTCHA - solve now", `Solve it within ${HUMAN_WAIT_MS / 60000} minutes.${REMOTE_VIEW_URL ? " Tap to open the live browser." : ""}`);
  const deadline = Date.now() + HUMAN_WAIT_MS;
  while (Date.now() < deadline && (await hasCaptcha())) await sleep(1500);
  if (await hasCaptcha()) throw new Error("Captcha not solved in time");
  log("Captcha cleared.");
}

async function clickByText(page, regex) {
  const candidates = page.locator("button, a, [role='button'], input[type='submit']").filter({ hasText: regex });
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const el = candidates.nth(i);
    if ((await el.isVisible().catch(() => false)) && (await el.isEnabled().catch(() => false))) {
      await el.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Tags the cheapest purchasable category (price <= MAX_PRICE) that has a quantity control, returns its price.
async function tagCheapestCategory(page) {
  return page.evaluate((maxPrice) => {
    const priceRe = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i;
    const found = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      if (el.children.length > 3) continue;
      const m = (el.textContent || "").trim().match(priceRe);
      if (!m || (el.textContent || "").length > 80) continue;
      const price = parseFloat(m[1].replace(/,/g, ""));
      if (!price || price > maxPrice) continue;
      let box = el;
      for (let i = 0; i < 6 && box.parentElement; i++) {
        box = box.parentElement;
        const hasControl = box.querySelector(
          "select, input[type='number'], [aria-label*='increase' i], [aria-label*='add' i], [aria-label*='plus' i], button"
        );
        const txt = box.textContent.toLowerCase();
        if (hasControl && box.textContent.length < 600) {
          if (!/sold out|unavailable|not available/.test(txt)) found.push({ price, box });
          break;
        }
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.price - b.price);
    found[0].box.setAttribute("data-bot-cat", "1");
    return found[0].price;
  }, MAX_PRICE);
}

async function setQuantity(page) {
  const box = page.locator("[data-bot-cat='1']").first();
  const select = box.locator("select").first();
  if (await select.count()) {
    await select.selectOption(String(QTY)).catch(() => {});
    return true;
  }
  const num = box.locator("input[type='number']").first();
  if (await num.count()) {
    await num.fill(String(QTY));
    return true;
  }
  const plus = box
    .locator("[aria-label*='increase' i], [aria-label*='add' i], [aria-label*='plus' i], button")
    .filter({ hasText: /^\s*(\+|add)?\s*$|\+/ })
    .last();
  if (await plus.count()) {
    for (let i = 0; i < QTY; i++) {
      await plus.click({ timeout: 4000 }).catch(() => {});
      await sleep(250);
    }
    return true;
  }
  return false;
}

async function fillBuyerDetails(page) {
  const fields = [
    ["input[type='email'], input[name*='email' i], input[placeholder*='email' i]", PROFILE.email],
    ["input[type='tel'], input[name*='phone' i], input[name*='mobile' i], input[placeholder*='mobile' i]", PROFILE.phone],
    ["input[name*='name' i], input[placeholder*='name' i]", PROFILE.name],
  ];
  for (const [selector, value] of fields) {
    if (!value) continue;
    const inputs = page.locator(selector);
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i);
      if ((await el.isVisible().catch(() => false)) && !(await el.inputValue().catch(() => "x"))) {
        await el.fill(value).catch(() => {});
      }
    }
  }
  const boxes = page.locator("input[type='checkbox']");
  for (let i = 0; i < (await boxes.count()); i++) {
    const b = boxes.nth(i);
    if ((await b.isVisible().catch(() => false)) && !(await b.isChecked().catch(() => true))) {
      await b.check({ force: true }).catch(() => {});
    }
  }
}

async function choosePaytm(page) {
  const option = page.locator("label, div, li, button, [role='radio'], [role='tab']").filter({ hasText: /paytm/i });
  const n = await option.count();
  for (let i = n - 1; i >= 0; i--) {
    const el = option.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 4000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

const SEATS_GONE_RE =
  /seats? (is|are)? ?(no longer|not) available|already (been )?(booked|sold)|session (has )?expired|insufficient (paytm )?(wallet )?balance|tickets? (just )?sold out/;
const LOGIN_RE = /(log ?in|sign ?in) (to|with)|enter (your )?(mobile|phone) number to (log|sign)/;
const CONFIRMED_RE = /booking confirmed|payment successful|order confirmed|tickets? (have been )?booked|thank you/;
const APPROVAL_PROMPT_RE = /\botp\b|one.?time password|enter (your )?(paytm )?pin|\bpasscode\b|verify (your )?(mobile|number)/;

async function waitForPaymentApproval(page) {
  // A Paytm wallet payment from a logged-in session usually needs no PIN/OTP,
  // so only raise the alarm if the page actually asks for one.
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  let alerted = false;
  while (Date.now() < deadline) {
    const t = await bodyText(page);
    if (CONFIRMED_RE.test(t)) {
      await shot(page, "confirmed");
      await notify("TICKETS BOOKED", `Booked ${QTY} tickets. Check your email/app.`, page.url(), "high");
      return true;
    }
    if (!alerted && APPROVAL_PROMPT_RE.test(t)) {
      alerted = true;
      await shot(page, "approval-needed");
      await notify(
        "APPROVE PAYMENT NOW",
        "Paytm is asking for a PIN/OTP. Enter it in the booking window.",
        page.url()
      );
    }
    await sleep(1000);
  }
  return false;
}

async function book(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await shot(page, "1-event");
  await waitIfCaptcha(page);

  if (!(await clickByText(page, new RegExp(BUY_WORDS.join("|"), "i")))) throw new Error("Buy button not found");
  await page.waitForLoadState("networkidle").catch(() => {});

  let quantitySet = false;
  let pickedPrice = null;
  let idleSteps = 0;

  for (let step = 2; step < 16; step++) {
    await waitIfCaptcha(page);
    await shot(page, `${step}-step`);
    const text = await bodyText(page);

    if (SEATS_GONE_RE.test(text)) throw new Error("Seats were taken or the session expired");

    if (LOGIN_RE.test(text) && !/paytm wallet/.test(text)) {
      await askHuman(page, "LOGIN NEEDED", "The site is asking you to log in again.");
      continue;
    }

    if (/paytm/.test(text) && /(payment|pay using|wallet|upi|card)/.test(text)) {
      await choosePaytm(page);
      await shot(page, `${step}-paytm-selected`);
      if (DRY_RUN) {
        await notify("DRY RUN OK", `Reached payment with ${QTY} x Rs ${pickedPrice}. Stopped before paying.`, page.url(), "default");
        return true;
      }
      await clickByText(page, /pay|proceed|continue|confirm/i);
      return waitForPaymentApproval(page);
    }

    if (!quantitySet) {
      pickedPrice = await tagCheapestCategory(page);
      if (pickedPrice !== null) {
        log(`Cheapest category: Rs ${pickedPrice}`);
        quantitySet = await setQuantity(page);
        if (!quantitySet) throw new Error("Found category but could not set quantity");
        await sleep(500);
      }
    }

    await fillBuyerDetails(page);
    const moved = await clickByText(page, NEXT_WORDS);
    if (!moved) {
      idleSteps++;
      await sleep(1500);
      if (idleSteps >= 3) {
        idleSteps = 0;
        await askHuman(page, "BOT STUCK", "Unknown page, no button the script recognises.");
      }
    } else {
      idleSteps = 0;
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(800);
  }
  throw new Error("Never reached the payment page");
}

const context = await chromium.launchPersistentContext("./profile", {
  headless: HEADLESS,
  locale: "en-IN",
  viewport: { width: 1280, height: 900 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});
const page = context.pages()[0] ?? (await context.newPage());

log(`Watching every ${INTERVAL_MS / 1000}s | qty ${QTY} | max price Rs ${MAX_PRICE} | dry run: ${DRY_RUN}`);
await notify("Watcher started", "Auto-booking watcher is running.", HOME_URL, "low");

let attempts = 0;
let done = false;
let lastHeartbeat = Date.now();
while (!done) {
  if (Date.now() - lastHeartbeat > 60 * 60 * 1000) {
    lastHeartbeat = Date.now();
    await notify("Still watching", "Watcher is alive. Tickets not live yet.", HOME_URL, "min");
  }
  try {
    const url = await findEventUrl(page);
    if (!url) {
      log("Event not listed yet.");
    } else if (!(await isLive(page, url))) {
      log("Listed, but tickets not on sale yet.");
    } else {
      attempts++;
      await notify("TICKETS LIVE", `Auto-booking attempt ${attempts}/${MAX_ATTEMPTS}`, url);
      try {
        done = await book(page, url);
      } catch (e) {
        log(`Booking attempt failed: ${e.message}`);
        await shot(page, "failed");
        await notifyShot(page, "Attempt failed", `${e.message}. Retrying (${attempts}/${MAX_ATTEMPTS}).`, "high");
        if (attempts >= MAX_ATTEMPTS) {
          await notify("AUTO-BOOK FAILED", `Gave up after ${attempts} attempts. Book manually now!`, url);
          done = true;
        }
      }
      if (!done) continue;
    }
  } catch (e) {
    log(`Check failed: ${e.message}`);
  }
  if (!done) await sleep(INTERVAL_MS);
}
await context.close();
