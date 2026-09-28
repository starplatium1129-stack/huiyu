// Migration-only neutral fixtures. Production never imports Node or sharp.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sharp = createRequire(path.join(repo, 'package.json'))('sharp');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huiyu-wd14-pixels-'));
const specifications = [
  ['square',448,448,3,'png'], ['portrait-up',71,113,3,'png'], ['landscape-down',1001,573,3,'png'],
  ['transparent',731,421,4,'png'], ['jpeg-shrink-exif',1501,923,3,'jpeg'],
  ['webp-shrink',601,997,4,'webp'], ['display-p3',731,421,3,'p3'], ['grey',351,127,3,'grey'], ['rgb16',719,421,3,'rgb16'],
  ['avif',411,313,4,'avif'], ['cmyk',719,421,3,'cmyk'], ['svg',901,537,3,'svg'],
];
const records = [];
for (const [name,width,height,channels,format] of specifications) {
  const bytes = Buffer.alloc(width*height*channels);
  for (let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const at=(y*width+x)*channels;
    bytes[at]=(x*37+y*3)%256;bytes[at+1]=(y*29+x*7)%256;bytes[at+2]=(x*13+y*11)%256;
    if(channels===4)bytes[at+3]=(x*5+y*3)%256;
  }
  let encoded=sharp(bytes,{raw:{width,height,channels}});
  let extension='png';
  if(format==='jpeg'){encoded=encoded.withMetadata({orientation:6}).jpeg({quality:91});extension='jpg';}
  else if(format==='webp'){encoded=encoded.webp({lossless:true});extension='webp';}
  else if(format==='p3')encoded=encoded.withIccProfile('p3').png();
  else if(format==='grey')encoded=encoded.greyscale().png();
  else if(format==='rgb16')encoded=encoded.toColourspace('rgb16').png();
  else if(format==='cmyk'){encoded=encoded.toColourspace('cmyk').jpeg();extension='jpg';}
  else if(format==='avif'){encoded=encoded.avif({lossless:true});extension='avif';}
  else encoded=encoded.png();
  let input=await encoded.toBuffer();
  if(format==='svg'){input=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#6174ae"/><circle cx="317.2" cy="213.8" r="153.7" fill="#ace637" fill-opacity=".7"/></svg>`);extension='svg';}
  const prepared=await sharp(input,{limitInputPixels:32*1024*1024,animated:false}).rotate().toColourspace('srgb')
    .resize(448,448,{fit:'contain',background:{r:255,g:255,b:255}}).removeAlpha().raw().timeout({seconds:5}).toBuffer();
  const source=`${name}.${extension}`,expected=`${name}.rgb`;
  await fs.writeFile(path.join(directory,source),input);await fs.writeFile(path.join(directory,expected),prepared);
  const metadata=await sharp(input).metadata();
  for(const [quality,scale] of [['standard',2],['compact',4]]){
    const output=await sharp(input).resize(Math.max(1,Math.floor(metadata.width/scale)),Math.max(1,Math.floor(metadata.height/scale)),{kernel:'lanczos3'}).webp({lossless:true,effort:3}).toBuffer();
    await fs.writeFile(path.join(directory,`${name}.${quality}`),output);
  }
  const thumbnail=await sharp(input,{limitInputPixels:32*1024*1024,animated:false}).rotate().resize({width:560,withoutEnlargement:true}).flatten({background:'#000000'}).jpeg({quality:82}).timeout({seconds:5}).toBuffer();
  await fs.writeFile(path.join(directory,`${name}.thumbnail`),thumbnail);
  records.push({name,source,expected,sha256:createHash('sha256').update(prepared).digest('hex'),bytes:prepared.length,input:await sharp(input).metadata()});
}
await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(records,null,2));
console.log(JSON.stringify({directory,sharp:sharp.versions.sharp,vips:sharp.versions.vips,fixtures:records.length}));
