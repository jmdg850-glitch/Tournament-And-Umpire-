const list = await fetch("http://127.0.0.1:9334/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
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
await new Promise((r) => setTimeout(r, 2000));
const t = await send("Runtime.evaluate", { expression: "document.title+'\\n'+document.body.innerText.slice(0,700)", returnByValue: true });
console.log(t.result.value);
const s = await send("Runtime.evaluate", { expression: "Object.keys(localStorage).filter(k=>/sb-|auth/i.test(k)).join(',')", returnByValue: true });
console.log("session_keys", s.result.value);
ws.close();
