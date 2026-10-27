/* Adapted from Anime2.5DRig app.js, MIT Copyright (c) 2026 hakoniwa.
 * Source: 852wa/Anime2.5DRig@7ddbd9943ea3152561b3dc8348fd752c850f3e95.
 * HUIYU: stage-only runtime; no editor, device access, random talking or OBS. */
(function(root){'use strict';
root.HuiyuAnime25D={create(cv,rig){
const gl=cv.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true});
if(!gl)throw new Error('此设备无法初始化 WebGL');
const RT=root.RigRuntime, Rigger=root.Rigger, renderer=root.RigRenderer.create(gl);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
const makeThumb=()=>'';
const A=rig.anchors,FS=A.faceScale,NP={...A.neckPivot},BP=A.bodyPivot,FC={x:A.face.cx,y:A.face.cy};
const fh=A.face.y1-A.face.y0;
const fw=A.face.x1-A.face.x0;
let motionGain=1,gazeGain=1,eyeOffset=0,mouthOffset=0;
const CHEST={cx:NP.cx,cy:A.neckBottom+fh*.6,rx:Math.max(1,(A.face.x1-A.face.x0)*.6),ry:Math.max(1,fh*.45)};
const bounce={x:0,v:0,dy:0},auto={phys:true},blinkVariant=1;
const P={angleX:0,angleY:0,angleZ:0,eyeOpenL:1,eyeOpenR:1,eyeX:0,eyeY:0,brow:0,
  mouthOpen:0,mouthForm:0,mouthCY:0,body:0,physAmp:1.25,soft:1.3,
  browAngL:0,browAngR:0,browAngSym:0,bangL:0,bangC:0,bangR:0,
  armY:0,armPos:0,bust:.45,bustY:1,irisScale:1,mouthEase:0.3,eyeEase:0.3,
  fhAmp:.85,fhSoft:0.35,eyeCY:0,eyeCAng:0,mouthCAng:0,eyeScaleL:1,eyeScaleR:1,mouthScale:1,accAmp:.7};

function prepareLayers(rig){
  const prepared=[],W=rig.canvas.w;
  const maxTexture=gl.getParameter(gl.MAX_TEXTURE_SIZE),maxViewport=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
  if(rig.canvas.w>maxViewport[0]||rig.canvas.h>maxViewport[1]||rig.canvas.w>maxTexture||rig.canvas.h>maxTexture)throw new Error('この端末の描画サイズ（'+Math.min(maxViewport[0],maxTexture)+'px）を超えています。PSDを縮小してください');
  try{
    for(const Lr of rig.layers){
      if(Lr.w>maxTexture||Lr.h>maxTexture)throw new Error('画像パーツがこの端末の上限 '+maxTexture+'px を超えています');
      const L=Object.assign({visible:true,opacity:1},Lr,{id:String(Lr.z)+':'+Lr.name});
      delete L.img;
      L.defaultDepth=L.depth;L.defaultOpacity=L.opacity;
      prepared.push(L);
      const cell=(L.phys?30:42)*Math.max(0.6,W/768);
      const {nx,ny}=RT.meshSize(L.w,L.h,cell),nv=(nx+1)*(ny+1);
      const base=new Float32Array(nv*2),uv=new Float32Array(nv*2);
      let k=0;
      for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){base[k]=L.x+L.w*i/nx;base[k+1]=L.y+L.h*j/ny;uv[k]=i/nx;uv[k+1]=j/ny;k+=2;}
      const idx=new Uint16Array(nx*ny*6);let q=0;
      for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const a=j*(nx+1)+i,b=a+1,c=a+nx+1,d=c+1;idx[q++]=a;idx[q++]=b;idx[q++]=c;idx[q++]=b;idx[q++]=d;idx[q++]=c;}
      L.base=base;L.cur=new Float32Array(base);
      L.bn=Rigger.baseName(L.name.replace(/_(l|r)$/,''));
      if(L.strands&&L.strands.length){
        const S=L.strands,nS=S.length;
        let spacing=120;
        if(nS>1){const ds=[];for(let s=1;s<nS;s++)ds.push(S[s].x-S[s-1].x);ds.sort((a,b)=>a-b);spacing=ds[ds.length>>1];}
        const sig=Math.max(1,spacing*0.6);
        L.sw=new Float32Array(nv*nS);L.su=new Float32Array(nv);
        L.spr=S.map((s,i)=>({stiff:{x:0,v:0,dx:0},soft:{x:0,v:0,dx:0},phase:i*1.37+L.z}));
        for(let v=0;v<nv;v++){
          const x=base[v*2],y=base[v*2+1];let tot=0;
          for(let s=0;s<nS;s++){const w=Math.exp(-Math.pow((x-S[s].x)/sig,2));L.sw[v*nS+s]=w;tot+=w;}
          let rY=0,tY=0;
          if(tot>1e-6){for(let s=0;s<nS;s++){L.sw[v*nS+s]/=tot;rY+=L.sw[v*nS+s]*S[s].rootY;tY+=L.sw[v*nS+s]*S[s].tipY;}}
          else{L.sw[v*nS]=1;rY=S[0].rootY;tY=S[0].tipY;}
          L.su[v]=clamp((y-rY)/Math.max(1,tY-rY),0,1);
        }
      }
      const image=(typeof ImageData!=='undefined')?new ImageData(Lr.img.data,Lr.img.width,Lr.img.height):Lr.img;
      L.thumb=makeThumb(image);
      renderer.upload(L,{positions:L.cur,uvs:uv,indices:idx,image});
    }
    return prepared;
  }catch(err){prepared.forEach(renderer.dispose);throw err;}
}

function fadeAlpha(L,e,alt){
  if(!L.fade)return 1;
  if(L.fade==='eyeOpen'){const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return smooth((v-(0.10+e.eyeEase*0.45))/0.15);}
  if(L.fade==='eyeClose'||L.fade==='eyeClose2'){
    const alternate=blinkVariant===2&&alt[L.side];
    if((L.fade==='eyeClose2')!==alternate)return 0;
    const v=L.side==='L'?e.eyeOpenL:e.eyeOpenR;return 1-smooth((v-(0.10+e.eyeEase*0.45))/0.15);
  }
  if(L.fade==='mouthOpen')return smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  if(L.fade==='mouthClose')return 1-smooth((e.mouthOpen-(0.05+e.mouthEase*0.35))/0.12);
  return 1;
}

const FRONTISH={'front hair':1,'side hair':1,'ahoge':1};
function deform(L,e){
  const b=L.base,o=L.cur,n=b.length;
  const isHead=L.group==='head';
  const az=e.angleZ*0.07,cz=Math.cos(az),sz=Math.sin(az);
  const ab=e.body*0.028,cb=Math.cos(ab),sb=Math.sin(ab);
  const bn=L.bn,eyeSide=L.side,EA=eyeSide==='L'?A.eyeL:(eyeSide==='R'?A.eyeR:null);
  const vOpen=eyeSide==='L'?e.eyeOpenL:e.eyeOpenR;
  const mo=e.mouthOpen,mHalfW=(A.mouth.x1-A.mouth.x0)/2;
  const nS=L.strands?L.strands.length:0;
  const bcx=L.x+L.w/2,bcy=L.y+L.h/2;
  const kind=L.phys==='sway'?'acc':FRONTISH[bn]?'fh':'bh';
  const physOn=nS&&auto.phys&&L.su;
  const ampK=kind==='acc'?e.accAmp*1.4:kind==='fh'?e.fhAmp:e.physAmp;
  const softK=kind==='acc'?0.8:kind==='fh'?e.fhSoft:e.soft;
  const powA=kind==='acc'?1.2:kind==='fh'?1.8:2.1;
  for(let k=0;k<n;k+=2){
    let x=b[k],y=b[k+1];
    const vi=k>>1;
    // --- closed-eye / mouth scale ---
    if(EA&&(bn==='eye_close'||bn==='eye_close2')){
      const sE=eyeSide==='L'?e.eyeScaleL:e.eyeScaleR;
      if(sE!==1){const cxE=(EA.x0+EA.x1)/2,cyE=(EA.y0+EA.y1)/2;x=cxE+(x-cxE)*sE;y=cyE+(y-cyE)*sE;}
    }
    if(bn==='mouth_open'||bn==='mouth_close'){
      const sM=e.mouthScale;
      if(sM!==1){x=A.mouth.cx+(x-A.mouth.cx)*sM;y=A.mouth.cy+(y-A.mouth.cy)*sM;}
    }
    // --- local features ---
    if(L.fade==='eyeOpen'&&EA){
      if(bn==='irides'){
        const isc=e.irisScale,ibx=e.irisBounceX||1,iby=e.irisBounceY||1;
        x=EA.icx+(x-EA.icx)*isc*ibx;y=EA.icy+(y-EA.icy)*isc*iby;
        x+=e.eyeX*11*FS;y+=e.eyeY*6*FS;
        const tl=smooth((0.32-vOpen)/0.32);   // iris stays round until nearly closed
        y=EA.closeY+(y-EA.closeY)*(1-0.80*tl);
      }else{
        y=EA.closeY+(y-EA.closeY)*(1-0.85*(1-vOpen));   // lid compression
      }
    }
    if((L.fade==='eyeClose'||L.fade==='eyeClose2')&&EA){
      y+=eyeOffset;
      y-=vOpen*3;y+=e.eyeCY*14*FS;
      const thE=e.eyeCAng*0.3*(eyeSide==='L'?1:-1);
      if(thE){const ct=Math.cos(thE),st=Math.sin(thE),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(bn==='eyebrow'){
      y+=(-e.brow*9+(1-vOpen)*3.5)*FS;
      const th=(eyeSide==='L'?(e.browAngL+e.browAngSym):(e.browAngR-e.browAngSym))*0.30;
      if(th){const ct=Math.cos(th),st=Math.sin(th),rx=x-bcx,ry=y-bcy;x=bcx+rx*ct-ry*st;y=bcy+rx*st+ry*ct;}
    }
    if(L.fade==='mouthOpen'){
      y=A.mouth.y0+(y-A.mouth.y0)*(0.5+0.5*mo);
      const q=Math.pow(Math.abs(x-A.mouth.cx)/(mHalfW+4),1.5);
      y-=e.mouthForm*6*FS*(q-0.35);
    }
    if(L.fade==='mouthClose'){
      y+=mouthOffset;
      y+=e.mouthCY*14*FS;
      const q=Math.pow(Math.abs(x-A.mouth.cx)/(mHalfW+4),1.5);
      y-=e.mouthForm*4*FS*(q-0.35);
      const thM=e.mouthCAng*0.35;
      if(thM){const ct=Math.cos(thM),st=Math.sin(thM),rx=x-A.mouth.cx,ry=y-A.mouth.cy;x=A.mouth.cx+rx*ct-ry*st;y=A.mouth.cy+rx*st+ry*ct;}
    }
    if(bn==='face'&&y>A.mouth.cy)y+=mo*6*FS*smooth((y-A.mouth.cy)/Math.max(1,A.face.y1-A.mouth.cy));
    // Bend smoothly from the waist to the shoulders. Head layers share the
    // shoulder displacement so the neck stays connected; the waist stays put.
    // This uses the existing mixed pose and each PSD's automatic proportions.
    const torso=isHead?1:smooth((BP.cy-y)/Math.max(fh,BP.cy-A.neckBottom));
    x+=(e.body*fw*.16+e.angleX*fw*.035)*torso*torso;
    y-=e.angleY*fw*.018*torso;
    // --- head transform ---
    let hw=isHead?1:(L.group==='body'?0.16:0);   // body subtly follows head XYZ
    if(bn==='neck')hw=0.55*smooth((A.neckBottom-y)/Math.max(1,A.neckBottom-A.neckTop));
    if(hw>0){
      const rx=x-NP.cx,ry=y-NP.cy,rx2=rx*cz-ry*sz,ry2=rx*sz+ry*cz;
      x+=(rx2-rx)*hw;y+=(ry2-ry)*hw;
      const dd=L.depth;
      x+=hw*FS*(e.angleX*(14+40*(dd-1))+e.angleX*(NP.cy-y)*0.028);
      y+=hw*FS*(-e.angleY*(9+30*(dd-1))-e.angleY*(dd-1)*(y-FC.y)*0.05);
    }
    // --- breathing ---
    y-=(L.group==='body'?e.breath*2.0:e.breathHead*1.6)*FS;
    if(bn==='topwear'&&y<CHEST.cy)y-=e.breath*2.2*FS*smooth((CHEST.cy-y)/(CHEST.ry*2));   // shoulders rise
    if(bn==='topwear')x=NP.cx+(x-NP.cx)*(1+e.breath*0.003);
    // --- bust jiggle ---
    if(bn==='topwear'){
      const gx=(x-CHEST.cx)/CHEST.rx,gy=(y-(CHEST.cy+e.bustY*70*FS))/CHEST.ry;
      y+=bounce.dy*e.bust*Math.exp(-gx*gx-gy*gy);
    }
    // --- arms ---
    if(bn==='handwear'){
      const w=smooth((y-L.y)/L.h*1.15);
      y-=e.armY*30*FS*w;y+=e.armPos*40*FS;x+=e.armY*6*FS*w*(x<NP.cx?1:-1);
    }
    // --- bang blocks ---
    if(L.bw){const m=Math.pow(L.su[vi],1.4)*22*FS;x+=(e.bangL*L.bw[vi*3]+e.bangC*L.bw[vi*3+1]+e.bangR*L.bw[vi*3+2])*m;}
    // --- strand physics: stiff root, fluffy tips (front hair / accessories have their own params) ---
    if(physOn){
      const u=kind==='fh'?Math.min(1,L.su[vi]*1.6):L.su[vi];
      const amp=Math.pow(u,powA)*ampK,softMix=Math.min(1,Math.pow(u,1.2)*softK);
      let dx=0;
      for(let s=0;s<nS;s++){const w=L.sw[vi*nS+s];if(w<0.001)continue;const sp=L.spr[s];dx+=w*(sp.stiff.dx*(1-softMix)+sp.soft.dx*softMix);}
      x+=dx*amp;y+=Math.abs(dx)*amp*0.12;
    }
    o[k]=x;o[k+1]=y;
  }
  // --- body rotation (around bottom center) ---
  if(Math.abs(ab)>1e-4){
    for(let k=0;k<n;k+=2){const rx=o[k]-BP.cx,ry=o[k+1]-BP.cy;o[k]=BP.cx+rx*cb-ry*sb;o[k+1]=BP.cy+rx*sb+ry*cb;}
  }
}
function updateSprings(e,t,dt,wind){
  const headDX=(e.angleX*14+e.angleZ*0.07*(NP.cy-FC.y))*FS+e.body*fw*.16+e.angleX*fw*.035;
  const bodyDX=e.body*0.028*(BP.cy-NP.cy)*0.35+e.angleX*14*0.16*FS;
  for(const L of layers){
    if(!L.spr)continue;
    const base=L.group==='head'?headDX:bodyDX,windScale=L.phys==='sway'&&L.group!=='head'?2.5:1;
    for(const sp of L.spr){
      const w=wind?(1.8*Math.sin(t*0.8+sp.phase)+1.0*Math.sin(t*1.9+sp.phase*2.3))*windScale:0;
      const txv=base+w*FS;
      RT.spring(sp.stiff,txv,70,9,dt);sp.stiff.dx=-(sp.stiff.x-txv)*2.2;
      RT.spring(sp.soft,txv,16,1.3,dt);sp.soft.dx=-(sp.soft.x-txv)*3.0;
    }
  }
  const bustTgt=(e.breath*3.0-e.angleY*6.0+e.body*4.0)*FS;
  RT.spring(bounce,bustTgt,140,4.2,dt);bounce.dy=-(bounce.x-bustTgt)*3.0;
}

let layers;
try{layers=prepareLayers(rig);}catch(error){gl.getExtension('WEBGL_lose_context')?.loseContext();throw error;}
cv.width=rig.canvas.w;cv.height=rig.canvas.h;
let last=0;
return {
calibrate(value){
  // Corrections are relative to each PSD's automatic anchors, never cumulative.
  NP.cx=A.neckPivot.cx+fw*value.pivotX/100;
  NP.cy=A.neckPivot.cy+fh*value.pivotY/100;
  CHEST.cx=NP.cx;
  motionGain=value.motion/100;gazeGain=value.gaze/100;
  eyeOffset=fh*value.eyeY/100;mouthOffset=fh*value.mouthY/100;
  P.eyeScaleL=P.eyeScaleR=value.eyeScale/100;P.mouthScale=value.mouthScale/100;
  P.physAmp=1.25*value.physics/100;P.fhAmp=.85*value.physics/100;P.accAmp=.7*value.physics/100;
  P.bust=.45*value.physics/100;
  for(const L of layers)L.depth=1+(L.defaultDepth-1)*value.depth/100;
},
render(input){
const t=input.time,dt=Math.max(0,Math.min(.05,t-last));last=t;
const reduced=input.reduced;
// HUIYU supplies one mixed FACS pose. Blink/emotion/speech ownership lives in
// the installed performance engine, not in a second independent idle loop.
const e=Object.assign({},P,input.pose);
e.angleX*=motionGain;e.angleY*=motionGain;e.angleZ*=motionGain;e.body*=motionGain;
e.eyeX*=gazeGain;e.eyeY*=gazeGain;
auto.phys=!reduced;updateSprings(e,t,dt,!reduced);
const items=[],masks=[];
for(const L of layers){const alpha=fadeAlpha(L,e,{L:false,R:false})*L.opacity;
const isMask=L.bn==='eyewhite'&&!!L.side;
if(alpha<.004&&!isMask)continue;
deform(L,e);renderer.positions(L,L.cur);
if(isMask)masks.push({L,side:L.side});
if(alpha>=.004)items.push({L,alpha,clip:L.bn==='irides'?L.side:null});}
renderer.draw({width:cv.width,height:cv.height,background:[0,0,0,0],items,masks});
},
destroy(){layers.forEach(renderer.dispose);layers=[];gl.getExtension('WEBGL_lose_context')?.loseContext();}
};
}};
})(self);
