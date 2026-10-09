import { chromium } from "playwright";
import readline from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const context = await chromium.launchPersistentContext("./profile", {
  headless: false,
  locale: "en-IN",
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://ticketgenie.in/");

console.log("\nLog in to ticketgenie.in in the opened window.");
console.log("Tick any 'remember me' option. Payment is by UPI QR, so no Paytm login is needed.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter here when you are logged in...");
rl.close();

const state = await context.storageState();
writeFileSync("session.b64", gzipSync(JSON.stringify(state)).toString("base64"));
await context.close();
console.log("Session saved to ./profile and ./session.b64 (for the cloud runner).");
console.log("Next: npm run upload-session");
