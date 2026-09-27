# AstralSwitch

Organiseur multi-comptes pour **Dofus Unity**, inspiré de [Dosoft](https://github.com/LuframeCode/dosoft).
Tauri 2 (Rust) + React + TypeScript.

AstralSwitch ne fait que gérer le focus des fenêtres : il ne rejoue aucun clic et n'automatise rien en jeu.

## Fonctions

- Détection automatique des fenêtres Dofus Unity (pseudo + classe lus dans le titre)
- Ordre d'initiative par glisser-déposer, sauvegardé
- Barre de portraits compacte, repliable, toujours au premier plan, fond transparent en option
- Teams nommées (renommer, dupliquer, jouer, supprimer), l'ordre de la team active = cycle
- Raccourcis globaux : suivant / précédent / afficher-masquer, et un raccourci direct par personnage
- Touches clavier avec Ctrl/Alt/Maj, boutons souris 4/5 et molette
- Icône dans la zone de notification, lancement au démarrage, position mémorisée
- Portraits de classe personnalisables (`public/classes/`), les jpg sont détourés automatiquement
- Raccourcis actifs uniquement quand Dofus est au premier plan (option)
- Fermeture d'un client depuis l'appli

## Développement

Prérequis : Node.js, Rust (`rustup`), Visual Studio Build Tools (C++).

```bash
npm install
npm run tauri dev      # appli complète
npm run dev            # interface seule dans le navigateur (données fictives)
npm run tauri build    # installeur dans src-tauri/target/release/bundle/nsis
```

## Publier une mise à jour

Les applications installées vérifient au démarrage
`https://github.com/Kyshin-hub/astralswitch/releases/latest/download/latest.json`
et proposent d'installer la nouvelle version (installeur signé).

```bash
npm run release -- 0.2.0 "Ce qui change"
```

Puis sur GitHub → Releases → *Draft a new release* : tag `v0.2.0`, déposer les deux fichiers
de `release\v0.2.0\` (`AstralSwitch_0.2.0_x64-setup.exe` et `latest.json`), publier.

La clé privée de signature est dans `%USERPROFILE%\.tauri\astralswitch.key` :
à sauvegarder précieusement (sans elle, les versions installées ne pourront plus se mettre à jour),
à ne jamais partager ni publier.

## Structure

```
src/                 Interface React
  api.ts             Pont vers Rust (+ faux backend pour le navigateur)
  App.tsx            Écrans Comptes / Raccourcis
  components.tsx     Cartes, boutons, raccourcis
src-tauri/src/
  lib.rs             État, commandes, threads de fond
  win.rs             Détection / focus / fermeture des fenêtres (Win32)
  hooks.rs           Hooks clavier + souris bas niveau
  config.rs          Configuration JSON (%APPDATA%\fr.astralswitch.desktop\config.json)
```
