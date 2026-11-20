export const eraserSizes=[10,20,40,60] as const;
export type EraserSize=typeof eraserSizes[number];
export type EraserMode="stroke"|"object";
export const defaultEraserSize:EraserSize=20;
export const eraserSize=(value:unknown):EraserSize=>eraserSizes.includes(value as EraserSize)?value as EraserSize:defaultEraserSize;
export const eraserMode=(value:unknown):EraserMode=>value==="object"?"object":"stroke";
