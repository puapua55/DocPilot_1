import {test,expect} from '@playwright/test';
import JSZip from 'jszip';
import {readFile,writeFile} from 'node:fs/promises';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';

async function fixture(){
 const z=new JSZip();
 z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 const p=t=>`<w:p><w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>${t}</w:t></w:r></w:p>`;
 z.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('Heading before the inserted image')}${p('Following paragraph must remain below the image, never behind it.')}${p('Another line follows the same document flow.')}<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/><w:left w:val="single" w:sz="8"/><w:right w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="6000" w:type="dxa"/></w:tcPr>${p('Table below the image and text')}</w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr></w:body></w:document>`);
 return z.generateAsync({type:'nodebuffer'});
}

for(const zoom of [100,150])test(`DOCX PDF preserves image space before following text and table at ${zoom}%`,async({page},info)=>{
 await page.goto('/');await page.locator('input[type=file]').first().setInputFiles({name:'image-flow.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:await fixture()});
 const heading=page.locator('.docx-content [data-docx-paragraph-index="0"]');await expect(heading).toBeVisible();
 await page.getByRole('group',{name:'DOCX 모드 선택'}).getByRole('button',{name:'편집',exact:true}).click();await heading.click();
 const jpg=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=140;const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,240,140);return c.toDataURL('image/jpeg').split(',')[1];});
 await page.locator('input[accept="image/png,image/jpeg,image/gif"]').setInputFiles({name:'red.jpg',mimeType:'image/jpeg',buffer:Buffer.from(jpg,'base64')});
 await expect(page.locator('.docx-added-image img')).toBeVisible();
 while(parseInt(await page.locator('.zoom-value').innerText(),10)<zoom)await page.getByRole('button',{name:'확대',exact:true}).click();
 const geometry=()=>page.locator('.docx-content section.docx').first().evaluate(section=>{
  const r=section.getBoundingClientRect(),s=r.width/section.offsetWidth;
  const rect=el=>{const b=el.getBoundingClientRect();return {left:(b.left-r.left)/s,top:(b.top-r.top)/s,right:(b.right-r.left)/s,bottom:(b.bottom-r.top)/s};};
  return {image:rect(section.querySelector('.docx-added-image img')),body:rect(section.querySelector('[data-docx-paragraph-index="1"]')),table:rect(section.querySelector('table'))};
 });
 const before=await geometry();expect(before.body.top).toBeGreaterThanOrEqual(before.image.bottom-1);
 await page.screenshot({path:info.outputPath('01-editor.png')});
 await page.getByRole('button',{name:'PDF 다운로드',exact:true}).click();const d=page.getByRole('dialog',{name:'PDF 다운로드 미리보기'});
 await expect(d.locator('.pdf-download-preview-page').first()).toHaveAttribute('data-rendered','true');await page.screenshot({path:info.outputPath('02-preview.png')});
 const pending=page.waitForEvent('download');await d.getByRole('button',{name:'확인',exact:true}).click();const bytes=await readFile(await(await pending).path());await writeFile(info.outputPath('saved.pdf'),bytes);
 const after=await geometry();expect(after).toEqual(before);
 const task=getDocument({data:new Uint8Array(bytes)});let inkAbove=0,inkBelow=0;
 try{
  const pdfPage=await(await task.promise).getPage(1),v=pdfPage.getViewport({scale:4/3}),c=createCanvas(Math.ceil(v.width),Math.ceil(v.height)),ctx=c.getContext('2d');await pdfPage.render({canvasContext:ctx,viewport:v}).promise;await writeFile(info.outputPath('03-saved-pdf.png'),c.toBuffer('image/png'));
  const pixels=ctx.getImageData(0,0,c.width,c.height).data;
  for(let y=Math.ceil(before.image.top+5);y<Math.floor(before.body.bottom);y++)for(let x=Math.ceil(before.body.left);x<Math.floor(before.body.right);x++){
   const i=(y*c.width+x)*4;if(pixels[i]<110&&pixels[i+1]<110&&pixels[i+2]<110){if(y<before.image.bottom-2)inkAbove++;if(y>=before.body.top-1)inkBelow++;}
  }
  const count=(color,rect)=>{let n=0;for(let y=Math.ceil(rect.top);y<Math.floor(rect.bottom);y++)for(let x=Math.ceil(rect.left);x<Math.floor(rect.right);x++){const i=(y*c.width+x)*4;if(color(pixels[i],pixels[i+1],pixels[i+2]))n++;}return n;};
  expect(count((r,g,b)=>r>200&&g<60&&b<60,before.image)).toBeGreaterThan(20000);
  expect(count((r,g,b)=>r<110&&g<110&&b<110,before.table)).toBeGreaterThan(300);
 }finally{await task.destroy();}
 await writeFile(info.outputPath('geometry.json'),JSON.stringify({before,after,inkAbove,inkBelow},null,2));
 expect(inkAbove,'following text must not move into the image area').toBe(0);
 expect(inkBelow,'following text must be painted at its editor position').toBeGreaterThan(300);
});
