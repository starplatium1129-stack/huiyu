/** Eight perimeter colors, clockwise from top-left. The interior of the artwork
 * never contributes to light outside its frame. One <=40px-wide readback. */
export function sampleCanvasAmbient(image: HTMLImageElement): string[] {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return []
  const canvas=image.ownerDocument.createElement('canvas')
  const scale=Math.min(1,40/Math.max(image.naturalWidth,image.naturalHeight))
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale))
  canvas.height=Math.max(1,Math.round(image.naturalHeight*scale))
  try {
    const context=canvas.getContext('2d',{willReadFrequently:true})
    if (!context) return []
    context.drawImage(image,0,0,canvas.width,canvas.height)
    const {data}=context.getImageData(0,0,canvas.width,canvas.height)
    const groups=Array.from({length:8},() => ({red:0,green:0,blue:0,weight:0}))
    const add=(index:number,offset:number,weight:number) => {
      const alpha=data[offset+3]/255
      const group=groups[index]
      group.red+=data[offset]*weight*alpha; group.green+=data[offset+1]*weight*alpha; group.blue+=data[offset+2]*weight*alpha; group.weight+=weight*alpha
    }
    // Use a narrow band rather than a single row so compression and thin borders
    // don't overpower the neighboring image. Every side has two spatial samples.
    const band=Math.max(1,Math.round(Math.min(canvas.width,canvas.height)*.12))
    for (let y=0;y<canvas.height;y++) for (let x=0;x<canvas.width;x++) {
      const offset=(y*canvas.width+x)*4
      if (y<band) add(x<canvas.width/2 ? 0:1,offset,1-y/band)
      if (x>=canvas.width-band) add(y<canvas.height/2 ? 2:3,offset,1-(canvas.width-1-x)/band)
      if (y>=canvas.height-band) add(x>=canvas.width/2 ? 4:5,offset,1-(canvas.height-1-y)/band)
      if (x<band) add(y>=canvas.height/2 ? 6:7,offset,1-x/band)
    }
    if (!groups.some(group => group.weight>0)) return []
    return groups.map(group => group.weight ? `${Math.round(group.red/group.weight)} ${Math.round(group.green/group.weight)} ${Math.round(group.blue/group.weight)}` : '0 0 0')
  } catch { return [] }
  finally { canvas.width=0; canvas.height=0 }
}
