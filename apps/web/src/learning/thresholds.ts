/**
 * Thresholds the UI has to NAME, in a module with no dependencies.
 *
 * The browser needs a few of the classroom's numbers in order to say what it
 * is showing — "composing unlocks at 80% recall competency" is not a
 * calculation, it is a label. Reading them out of `teacher/conversation`
 * dragged four teacher modules (the word lists, the conversation packs, the
 * eloquence pairs, the gate table) into the page bundle for one float.
 *
 * So the numbers live here, at a leaf: the client imports this and nothing
 * else from the model's side of the tree, and the model imports it too, so
 * there is exactly one definition. Anything that needs a CALCULATION rather
 * than a number belongs on the server behind an endpoint.
 */

/** Recall competency at which the composition layer is allowed to speak. */
export const CREATIVE_UNLOCK_THRESHOLD = 0.8;
