// The "this is a simulation" notice: a modal on arrival (EN/ES) and a pill that reopens it.
const TEXT = {
  en: {
    eyebrow: "Interactive demo",
    title: "You are exploring a simulated gateway",
    body: "This is the real llm-gateway dashboard, running entirely in your browser. All data is simulated: requests are generated locally, and every call the dashboard makes is answered by a built-in stand-in that behaves like the gateway and its AI providers. No real provider is contacted, there are no real keys, and nothing you change is saved.",
    tryTitle: "Things to try",
    tries: [
      "In Settings, open Balancer and change a provider's weight. The traffic mix follows.",
      "Add a provider and press Send test message to see how a request is translated.",
      "Open any request in Requests to inspect its details.",
    ],
    start: "Start exploring",
    source: "View source on GitHub",
    pill: "Simulated data",
    pillTitle: "About this demo",
  },
  es: {
    eyebrow: "Demo interactiva",
    title: "Estás explorando un gateway simulado",
    body: "Este es el panel real de llm-gateway, funcionando íntegramente en tu navegador. Todos los datos son simulados: las peticiones se generan en local y cada llamada del panel la responde un sustituto integrado que se comporta como el gateway y sus proveedores de IA. No se contacta con ningún proveedor real, no hay claves reales y nada de lo que cambies se guarda.",
    tryTitle: "Qué probar",
    tries: [
      "En Settings, abre Balancer y cambia el peso de un proveedor. El reparto del tráfico lo sigue.",
      "Añade un proveedor y pulsa Send test message para ver cómo se traduce una petición.",
      "Abre cualquier petición en Requests para ver su detalle.",
    ],
    start: "Empezar a explorar",
    source: "Ver el código en GitHub",
    pill: "Datos simulados",
    pillTitle: "Sobre esta demo",
  },
};

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) (k === "class" ? (n.className = v) : k === "text" ? (n.textContent = v) : k.startsWith("on") ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v));
  n.append(...kids.flat());
  return n;
};

let lang = (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
const dialog = el("dialog", { class: "modal demo-modal", "aria-labelledby": "demo-title" });
document.body.append(dialog);

function paint() {
  const t = TEXT[lang];
  document.documentElement.lang = lang;
  dialog.replaceChildren(
    el("div", { class: "modal-b" },
      el("div", { class: "demo-top" },
        el("span", { class: "chip info", text: t.eyebrow }),
        el("div", { class: "demo-lang", role: "group", "aria-label": "Language" },
          ...["en", "es"].map((l) => el("button", { type: "button", "aria-pressed": String(l === lang), text: l.toUpperCase(), onclick: () => { lang = l; paint(); } })))),
      el("h2", { id: "demo-title", text: t.title }),
      el("p", { class: "muted", text: t.body }),
      el("div", { class: "sec-h", style: "margin:20px 0 8px", text: t.tryTitle }),
      el("ul", { class: "demo-list" }, ...t.tries.map((x) => el("li", { text: x })))),
    el("div", { class: "modal-f" },
      el("a", { class: "btn", href: "https://github.com/nicogarcia0/llm-gateway", target: "_blank", rel: "noopener", text: t.source }),
      el("button", { class: "btn primary", type: "button", text: t.start, onclick: () => dialog.close() })));
  pill.textContent = t.pill;
  pill.title = t.pillTitle;
}

const pill = el("button", { class: "btn demo-pill", type: "button", onclick: () => dialog.showModal() });
const mount = () => {
  const tools = document.querySelector(".tools");
  if (tools && !tools.contains(pill)) tools.prepend(pill);
};
new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
mount();
paint();
dialog.showModal();
