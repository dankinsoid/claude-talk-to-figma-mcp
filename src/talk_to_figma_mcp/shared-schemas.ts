// @ai-generated(guided)
// Hand-modeled value schemas shared by the generated field maps
// (write_schema.generated.ts) and the hand-composed write_schema.ts.
// Kept here so the generator can import them without a cycle: generated →
// shared, write_schema → generated + shared.

import { z } from "zod";

/** A color as `#RRGGBB`/`#RRGGBBAA` (converted to Figma rgb 0-1) or raw rgba floats. */
export const Color = z.union([
  z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "expected #RRGGBB or #RRGGBBAA hex"),
  z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number().optional() }),
]);

export const Paint = z
  .object({
    type: z
      .enum(["SOLID", "GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND", "IMAGE"])
      .optional(),
    color: Color.optional().describe("SOLID paint color, #RRGGBB"),
    opacity: z.number().min(0).max(1).optional(),
    // IMAGE paint: pass a URL and the server fetches the bytes and imports them
    // into Figma for you (no imageHash juggling). type defaults to "IMAGE" when
    // imageUrl is present. Alternatively pass an imageHash you already have.
    imageUrl: z
      .string()
      .optional()
      .describe('image fill source — https URL, file:// URL or local file path (/abs or ~/); read/fetched server-side and imported; implies type "IMAGE"'),
    imageHash: z.string().optional().describe("pre-imported Figma image hash (alternative to imageUrl)"),
    scaleMode: z
      .enum(["FILL", "FIT", "CROP", "TILE"])
      .optional()
      .describe("IMAGE paint scale mode (default FILL)"),
  })
  .passthrough();

export const FontName = z
  .object({ family: z.string(), style: z.string().describe('face name, e.g. "Regular", "Bold Italic"') })
  .describe("font; loaded automatically before write");

// Figma types these as {value, unit} objects, NOT plain numbers — a bare number
// is accepted as a PIXELS shorthand (coerced plugin-side) so the common case
// stays terse, but the object form is needed for PERCENT / AUTO.
export const LetterSpacing = z.union([
  z.number(),
  z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
]);

export const LineHeight = z.union([
  z.number(),
  z.object({ value: z.number(), unit: z.enum(["PIXELS", "PERCENT"]) }),
  z.object({ unit: z.literal("AUTO") }),
]);

// Effect (shadows/blurs) is a wide discriminated union in Figma; modeled loosely
// here (type-tagged, passthrough) to keep the schema/doc compact — the plugin
// assigns it straight onto the node and Figma validates the full shape.
export const Effect = z
  .object({ type: z.string().describe("DROP_SHADOW | INNER_SHADOW | LAYER_BLUR | BACKGROUND_BLUR | ...") })
  .passthrough();
