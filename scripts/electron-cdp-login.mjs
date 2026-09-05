const version = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const page = version.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.error("no page target", version.map((t) => t.type));
  process.exit(1);
}

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
const before = await send("Runtime.evaluate", {
  expression: "document.title + '\\n' + document.body.innerText.slice(0, 800)",
  returnByValue: true,
});
console.log("--- before ---");
console.log(before.result.value);

const login = await send("Runtime.evaluate", {
  expression: `(() => {
    const setVal = (el, value) => {
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      proto.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const email = document.querySelector('input[type="email"], input[name="email"], #email');
    const password = document.querySelector('input[type="password"]');
    if (!email || !password) return { ok: false, reason: "no inputs", html: document.body.innerText.slice(0, 200) };
    setVal(email, "organizer.dev@tournament.local");
    setVal(password, "dev-organizer-pass");
    const buttons = [...document.querySelectorAll("button")];
    const signIns = buttons.filter((b) => /sign in/i.test((b.textContent || "").trim()));
    const signIn = signIns.at(-1);
    if (!signIn) return { ok: false, reason: "no sign in button", labels: buttons.map((b) => b.textContent) };
    signIn.click();
    return { ok: true, clicked: (signIn.textContent || "").trim(), count: signIns.length };
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("--- click ---");
console.log(JSON.stringify(login.result.value));

await new Promise((r) => setTimeout(r, 5000));

const after = await send("Runtime.evaluate", {
  expression: "document.title + '\\n' + document.body.innerText.slice(0, 1200)",
  returnByValue: true,
});
console.log("--- after ---");
console.log(after.result.value);

const session = await send("Runtime.evaluate", {
  expression: `(() => {
    const keys = Object.keys(localStorage);
    const authKeys = keys.filter((k) => /supabase|auth|sb-/i.test(k));
    return {
      keys: authKeys,
      hasAccessToken: authKeys.some((k) => {
        try {
          const v = localStorage.getItem(k) || "";
          return v.includes("access_token") || v.includes("sb-");
        } catch { return false; }
      }),
    };
  })()`,
  returnByValue: true,
});
console.log("--- session ---");
console.log(JSON.stringify(session.result.value));

ws.close();
