const list = await fetch("http://127.0.0.1:9333/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
const body = await send("Runtime.evaluate", {
  expression: "document.body.innerText",
  returnByValue: true,
});
console.log(body.result.value);
const click = await send("Runtime.evaluate", {
  expression: `(() => {
    const buttons = [...document.querySelectorAll("button")];
    const open = buttons.find((b) => /open/i.test((b.textContent || "").trim()));
    if (open) { open.click(); return { clicked: open.textContent.trim() }; }
    const row = [...document.querySelectorAll("tr, [data-tournament], .card")].find((el) => /tournament|open/i.test(el.textContent || ""));
    return { clicked: null, sample: document.body.innerText.slice(0, 1500) };
  })()`,
  returnByValue: true,
});
console.log("--- click ---");
console.log(JSON.stringify(click.result.value).slice(0, 2000));
await new Promise((r) => setTimeout(r, 2500));
const after = await send("Runtime.evaluate", {
  expression: "document.body.innerText.slice(0, 1800)",
  returnByValue: true,
});
console.log("--- after open ---");
console.log(after.result.value);
ws.close();
