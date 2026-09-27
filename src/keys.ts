import type { Hotkey } from "./api";

const NAMED: Record<number, string> = {
  0x08: "Retour", 0x09: "Tab ↹", 0x0d: "Entrée", 0x13: "Pause", 0x14: "Verr. Maj",
  0x1b: "Échap", 0x20: "Espace", 0x21: "Pg ↑", 0x22: "Pg ↓", 0x23: "Fin", 0x24: "Début",
  0x25: "←", 0x26: "↑", 0x27: "→", 0x28: "↓", 0x2d: "Inser", 0x2e: "Suppr",
  0x6a: "Num *", 0x6b: "Num +", 0x6d: "Num -", 0x6e: "Num .", 0x6f: "Num /",
  0x2c: "Impr. écran", 0x91: "Arrêt défil", 0x90: "Verr. Num", 0x5d: "Menu",
  // Touches « OEM » en disposition AZERTY française
  0xde: "²", 0xdb: ")", 0xbb: "=", 0xdd: "^", 0xba: "$", 0xc0: "ù", 0xdc: "*",
  0xbc: ",", 0xbe: ";", 0xbf: ":", 0xdf: "!", 0xe2: "<", 0xbd: "-",
  0x1_0003: "Molette", 0x1_0004: "Souris 4", 0x1_0005: "Souris 5",
};

export function keyName(code: number): string {
  if (NAMED[code]) return NAMED[code];
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return String.fromCharCode(code);
  if (code >= 0x60 && code <= 0x69) return `Num ${code - 0x60}`;
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`;
  return `0x${code.toString(16).toUpperCase()}`;
}

export function hotkeyParts(h: Hotkey): string[] {
  const parts: string[] = [];
  if (h.ctrl) parts.push("Ctrl");
  if (h.alt) parts.push("Alt");
  if (h.shift) parts.push("⇧ Maj");
  parts.push(keyName(h.code));
  return parts;
}
