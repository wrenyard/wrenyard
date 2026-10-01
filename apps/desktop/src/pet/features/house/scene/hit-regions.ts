/**
 * House geometry shared by the sprite scene and the React overlay.
 *
 * DOM chrome uses `data-hit` + `document.elementFromPoint`; the sprite uses the
 * authored pixel program (`pixelProgramCoversPoint`). Only the physical
 * rectangle type remains here.
 */

export interface HouseRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
