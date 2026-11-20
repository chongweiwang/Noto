// UI-only colors, selected from the stored paper color; never modify the document.
export function drawingUiColors(background:string){
 function luminanceOf(color:string){const rgb=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);if(!rgb)return null;const channels=rgb.slice(1).map(part=>parseInt(part,16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];}
 const luminance=luminanceOf(background);
 if(luminance===null)return {grid:"#cbd5e1",selection:"#1d4ed8"};
 const contrast=(other:number)=>(Math.max(luminance,other)+.05)/(Math.min(luminance,other)+.05);
 // Use a blue outline when it has sufficient contrast; otherwise use black or
 // white for mid-tone paper. These values are only transient UI decoration.
 const dark=contrast(luminanceOf("#1d4ed8")!),light=contrast(luminanceOf("#b9d8ff")!);
 const selection=Math.max(dark,light)>=3?(dark>light?"#1d4ed8":"#b9d8ff"):(luminance>.18?"#111827":"#ffffff");
 return {grid:"#94a3b8",selection};
}
