import {expect,it} from "vitest";
import {visibleGridHeight,onGridLevel} from "./gridLevels";
it("pins the visible grid to zero above ground and follows negative heights",()=>{
  expect(visibleGridHeight(0)).toBe(0);
  expect(visibleGridHeight(2.5)).toBe(0);
  expect(visibleGridHeight(6.25)).toBe(0);
  expect(visibleGridHeight(-2.5)).toBe(-2.5);
  expect(visibleGridHeight(-5)).toBe(-5);
  expect(onGridLevel(10,1)).toBe(true);
});
