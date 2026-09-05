const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const messageId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
}
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", reject);
});
await send("Runtime.enable");

async function text() {
  const r = await send("Runtime.evaluate", { expression: "document.title+'\\n'+document.body.innerText", returnByValue: true });
  return r.result.value;
}

function setNative(elExpr, value) {
  return `(() => { const el=${elExpr}; const proto=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value"); proto.set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return el.value; })()`;
}

async function login() {
  await send("Runtime.evaluate", { expression: setNative('document.querySelector("input[type=email]")', "organizer.dev@tournament.local"), returnByValue: true });
  await send("Runtime.evaluate", { expression: setNative('document.querySelector("input[type=password]")', "dev-organizer-pass"), returnByValue: true });
  await send("Runtime.evaluate", {
    expression: `(() => { const bs=[...document.querySelectorAll("button")].filter(b=>/sign in/i.test((b.textContent||"").trim())); bs.at(-1).click(); return bs.length; })()`,
    returnByValue: true,
  });
}

const t0 = await text();
console.log("--- initial ---");
console.log(t0.slice(0, 500));

if (/Sign in to run/i.test(t0)) {
  await login();
  await new Promise((r) => setTimeout(r, 5000));
}
const t1 = await text();
console.log("--- after login ---");
console.log(t1.slice(0, 700));
const loggedIn = /OPERATOR DESK|Dashboard|organizer\.dev@tournament/.test(t1);
console.log("logged_in", loggedIn);

const open = await send("Runtime.evaluate", {
  expression: `(() => { const b=[...document.querySelectorAll("button")].find(x=>/open/i.test((x.textContent||"").trim())); if(b){b.click(); return true;} return false; })()`,
  returnByValue: true,
});
console.log("opened_tournament", open.result.value);
await new Promise((r) => setTimeout(r, 4000));
const t2 = await text();
console.log("--- tournament ---");
console.log(t2.slice(0, 600));

await send("Runtime.evaluate", {
  expression: `(() => { const b=[...document.querySelectorAll("button")].find(x=>/^sign out$/i.test((x.textContent||"").trim())); if(!b) return false; b.click(); return true; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 2500));
const t3 = await text();
console.log("--- after logout ---");
console.log(t3.slice(0, 400));
const loggedOut = /Sign in to run/i.test(t3);
console.log("logged_out", loggedOut);

await login();
await new Promise((r) => setTimeout(r, 5000));
const t4 = await text();
console.log("--- second login ---");
console.log(t4.slice(0, 600));
console.log("second_login", /OPERATOR DESK|Dashboard/.test(t4));
const session = await send("Runtime.evaluate", {
  expression: `JSON.stringify({keys:Object.keys(localStorage).filter(k=>/supabase|auth|sb-/i.test(k))})`,
  returnByValue: true,
});
console.log("session", session.result.value);
ws.close();
