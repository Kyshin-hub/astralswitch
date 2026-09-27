// Couleurs par classe Dofus, utilisées pour les avatars.
const CLASS_COLORS: Record<string, [string, string]> = {
  iop: ["#f0643c", "#b3261e"],
  cra: ["#8bc34a", "#3e7d1e"],
  eniripsa: ["#ff7eb6", "#c2185b"],
  sadida: ["#6fcf6f", "#2e7d32"],
  osamodas: ["#4fc3f7", "#1565c0"],
  enutrof: ["#ffd54f", "#c49000"],
  sram: ["#9e9e9e", "#424242"],
  xelor: ["#7986cb", "#303f9f"],
  ecaflip: ["#ffb74d", "#e65100"],
  feca: ["#fff176", "#b8a200"],
  sacrieur: ["#e57373", "#8e0000"],
  pandawa: ["#a1887f", "#4e342e"],
  roublard: ["#ba68c8", "#6a1b9a"],
  zobal: ["#90a4ae", "#37474f"],
  steamer: ["#4db6ac", "#00695c"],
  eliotrope: ["#64ffda", "#00897b"],
  huppermage: ["#b388ff", "#5e35b1"],
  ouginak: ["#bcaaa4", "#5d4037"],
  forgelance: ["#ffab91", "#bf360c"],
};

export function normalizeClass(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export function classColor(className: string): string {
  return CLASS_COLORS[normalizeClass(className)]?.[0] ?? "#8b93a7";
}

export function classGradient(className: string): string {
  const [a, b] = CLASS_COLORS[normalizeClass(className)] ?? ["#8b93a7", "#454b5c"];
  return `linear-gradient(135deg, ${a}, ${b})`;
}
