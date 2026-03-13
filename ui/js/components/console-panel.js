export function appendConsoleLine(id, line) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent += `${line}\n`;
}
