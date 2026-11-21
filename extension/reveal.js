function elementText(element) {
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.pointerEvents !== "none" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function clickableTarget(element) {
  let current = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const role = current.getAttribute?.("role");
    const tag = current.tagName?.toLowerCase();
    const isClickable =
      ["button", "a", "label"].includes(tag) ||
      role === "button" ||
      current.hasAttribute?.("onclick") ||
      current.hasAttribute?.("tabindex") ||
      style.cursor === "pointer" ||
      current.classList?.contains("btn") ||
      current.classList?.contains("button");

    if (isClickable) return current;
    current = current.parentElement;
  }
  return element;
}

function dispatchMouseSequence(element) {
  element.scrollIntoView?.({ block: "center", inline: "center", behavior: "auto" });
  element.focus?.({ preventScroll: true });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const EventCtor = type.startsWith("pointer") && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
    element.dispatchEvent(
      new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type.includes("down") ? 1 : 0
      })
    );
  }
  element.click?.();
}

(() => {
  const matcher = /\b(show|reveal|view|display|see)\s+(number|phone|telephone|mobile|contact)\b/i;
  const allVisible = [...document.body.querySelectorAll("*")].filter(isVisible);
  const matching = allVisible
    .filter((element) => matcher.test(elementText(element)))
    .filter((element) => ![...element.children].some((child) => matcher.test(elementText(child))))
    .slice(0, 6);

  const targets = [];
  for (const match of matching) {
    const target = clickableTarget(match);
    if (!targets.includes(target)) targets.push(target);
  }

  for (const target of targets) {
    dispatchMouseSequence(target);
  }

  return {
    clicked: targets.length,
    matched: matching.length,
    labels: matching.map(elementText).filter(Boolean),
    target_labels: targets.map(elementText).filter(Boolean).slice(0, 6)
  };
})();
