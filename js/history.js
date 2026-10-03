// Historial de mensajes recibidos, guardado en el navegador (localStorage).
// Es solo para este telefono: no se sincroniza con nada. Si el almacenamiento
// no esta disponible (modo privado, bloqueado) la app sigue andando sin historial.

const KEY = "memetransfer.history.v1";
export const MAX_ITEMS = 50;

export class History {
  /** @param {Storage|null} storage normalmente window.localStorage */
  constructor(storage) {
    this.storage = storage;
  }

  list() {
    try {
      const items = JSON.parse(this.storage?.getItem(KEY) ?? "[]");
      return Array.isArray(items) ? items.filter((i) => typeof i?.text === "string") : [];
    } catch {
      return [];
    }
  }

  #save(items) {
    try {
      this.storage?.setItem(KEY, JSON.stringify(items));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Agrega un mensaje al principio. Si el mismo texto ya es el ultimo
   * recibido (el emisor sigue en loop y se recibio de nuevo), solo actualiza la fecha.
   * @returns {object} el item guardado
   */
  add(text, now = Date.now()) {
    const items = this.list();
    if (items[0]?.text === text) {
      items[0].at = now;
      this.#save(items);
      return items[0];
    }
    const item = { id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text, at: now };
    items.unshift(item);
    this.#save(items.slice(0, MAX_ITEMS));
    return item;
  }

  remove(id) {
    this.#save(this.list().filter((i) => i.id !== id));
  }

  clear() {
    try {
      this.storage?.removeItem(KEY);
    } catch {
      // nada que hacer
    }
  }
}

/** Link para mandar el texto por WhatsApp (se usa si el navegador no tiene Compartir). */
export function whatsappUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/**
 * Comparte el texto con el menu nativo del telefono (WhatsApp, Telegram, mail...).
 * Sin Web Share API (computadoras) abre WhatsApp Web.
 * @returns {Promise<"shared"|"cancelled"|"whatsapp">}
 */
export async function shareText(text, nav = globalThis.navigator, open = (url) => globalThis.open(url, "_blank", "noopener")) {
  if (nav?.share) {
    try {
      await nav.share({ text });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // otro error (p. ej. no permitido): caer a WhatsApp
    }
  }
  open(whatsappUrl(text));
  return "whatsapp";
}
