/**
 * Consistent destructive-action styling for alert dialogs.
 *
 * The generated `AlertDialogAction` renders the neutral primary button, which
 * used to put a near-white label on the default primary fill. Destructive
 * confirmations instead use this deep-red treatment at the call site (rather
 * than editing the generated button primitive): white on `red-800` is >= 7:1
 * and stays clearly "danger" in every dark surface.
 */
export const DANGER_ACTION_CLASS =
  'bg-red-800 text-white hover:bg-red-700 focus-visible:ring-red-400/60';
