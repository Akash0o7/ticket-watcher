import { chromium } from "playwright";
import readline from "node:readline/promises";

const context = await chromium.launchPersistentContext("./profile", {
  headless: false,
  locale: "en-IN",
  viewport: null,
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://ticketgenie.in/");

console.log("\nLog in to ticketgenie.in in the opened window.");
console.log("Then open a ticket checkout once and, if it offers 'Paytm', log in to Paytm and tick any 'remember' option.");
console.log("Your login is saved only in ./profile on this computer.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Press Enter here when you are logged in...");
rl.close();
await context.close();
console.log("Session saved. Now run: npm start");
