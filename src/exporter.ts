import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import TurndownService from "turndown";
import markdownDocx, { Packer } from "markdown-docx";
import type { DuplicateInfo, ExportControl, ExportOptions, ExportRecord, ListingReport, TaskEvent, WeixinItem } from "./types.js";
import { MIN_DEDUP_TEXT_LENGTH, contentHash, isoDate, normalizePlainText, safeName, sleep, writeFileAtomic, writeJson } from "./util.js";
import { downloadImage, extractImageUrls, normalizeImageSources } from "./weixinMedia.js";
import { DeletedContentError, SessionExpiredError, type ContentSource } from "./source/types.js";

// Ported from zhi-dang's Exporter almost unchanged — this layer (Markdown
// conversion, image localization/dedup, Word export, incremental manifest
// writes for resume) has nothing to do with Zhihu specifically and needed no
// real rework, just dropping the "answer vs article" split (WeChat only has
// one kind of content here) and renaming the Zhihu-flavored field names to
// what they actually mean.
async function waitWhilePaused(control:ExportControl){ while(control.paused) await sleep(300); }

export class Exporter {
  private td=new TurndownService({headingStyle:"atx",codeBlockStyle:"fenced",bulletListMarker:"-"});
  private imageCache=new Map<string,string>();
  async export(items:WeixinItem[],listingReport:ListingReport,opts:ExportOptions,source:ContentSource,onEvent:(e:TaskEvent)=>void,control:ExportControl={paused:false,skippedItemIds:new Set(),skipImagesItemIds:new Set()}){
    this.imageCache.clear(); await mkdir(opts.outputDir,{recursive:true});
    const records:ExportRecord[]=[]; const imageFailures:ImageFailure[]=[]; const itemFailures:ItemFailure[]=[]; const skippedItems:SkippedItem[]=[]; const deletedItems:DeletedItem[]=[]; const wordFailures:WordFailure[]=[];
    const hashGroups=new Map<string,{id:string;title:string}[]>();
    const noteContentHash=(item:WeixinItem,html:string)=>{
      if(normalizePlainText(html).length<MIN_DEDUP_TEXT_LENGTH) return;
      const hash=contentHash(html);
      const group=hashGroups.get(hash);
      const entry={id:item.id,title:item.title};
      if(!group){ hashGroups.set(hash,[entry]); return; }
      group.push(entry);
      if(group.length<2) return;
      for(const member of group){
        const info:DuplicateInfo={groupSize:group.length,otherTitles:group.filter(g=>g.id!==member.id).map(g=>g.title)};
        onEvent({type:"duplicate",id:member.id,info});
      }
    };
    const persist=()=>this.writeManifests(opts.outputDir,items.length,listingReport,records,itemFailures,skippedItems,deletedItems,imageFailures,wordFailures);
    let sessionExpired=false;
    for(let i=0;i<items.length;i++){
      const item=items[i];
      if(control.skippedItemIds.has(item.id)){ skippedItems.push({itemId:item.id,title:item.title}); onEvent({type:"done",id:item.id,status:"skipped"}); await persist(); continue; }
      const resumed=control.resumedRecords?.get(item.id);
      if(resumed){ records.push(resumed); onEvent({type:"done",id:item.id,status:"done"}); await persist(); continue; }
      if(control.deletedItemIds?.has(item.id)){ deletedItems.push({itemId:item.id,title:item.title}); onEvent({type:"done",id:item.id,status:"deleted"}); await persist(); continue; }
      if(sessionExpired) continue;
      await waitWhilePaused(control);
      let html:string;
      try{ html=await this.fetchBodyWithRetry(source,item); }
      catch(error){
        if(error instanceof SessionExpiredError){ sessionExpired=true; continue; }
        onEvent({type:"start",id:item.id});
        if(error instanceof DeletedContentError){ deletedItems.push({itemId:item.id,title:item.title}); onEvent({type:"done",id:item.id,status:"deleted"}); await persist(); await sleep(opts.delayMs); continue; }
        const message=error instanceof Error?error.message:String(error);
        itemFailures.push({itemId:item.id,title:item.title,error:message}); onEvent({type:"done",id:item.id,status:"error",error:message});
        await persist(); await sleep(opts.delayMs); continue;
      }
      noteContentHash(item,html);
      onEvent({type:"start",id:item.id});
      try{
        const folder=path.join(opts.outputDir,"articles"); await mkdir(folder,{recursive:true}); let cover:string|null=item.coverUrl;
        if(opts.downloadImages){
          if(control.skipImagesItemIds.has(item.id)){
            onEvent({type:"subtask",id:item.id,key:"images",status:"skipped"});
          }else{
            onEvent({type:"subtask",id:item.id,key:"images",status:"active"});
            const localized=await this.localizeImages(html,path.join(opts.outputDir,"images"),item.id,item.coverUrl?[item.coverUrl]:[],onEvent);
            html=localized.html; imageFailures.push(...localized.failures); if(item.coverUrl&&localized.paths.has(item.coverUrl))cover=localized.paths.get(item.coverUrl)!;
            onEvent({type:"subtask",id:item.id,key:"images",status:localized.failures.length?"error":"done"});
          }
        }
        await waitWhilePaused(control);
        onEvent({type:"subtask",id:item.id,key:"write",status:"active"});
        const markdown=this.td.turndown(html); const markdownCover=cover?.startsWith("images/")?`../${cover}`:cover; const front=["---",`id: "${item.id}"`,`title: ${JSON.stringify(item.title)}`,`url: ${item.url}`,`created: ${isoDate(item.created)}`,`updated: ${isoDate(item.updated)}`,`read_count: ${item.readCount??"null"}`,`like_count: ${item.likeCount??"null"}`,`comment_count: ${item.commentCount??"null"}`,...(markdownCover?[`cover: ${JSON.stringify(markdownCover)}`]:[]),"---","",`# ${item.title}`,"",markdown,"",`[原文链接](${item.url})`,""];
        const baseName=`${new Date(item.created*1000).toISOString().slice(0,10)}-${item.id}-${safeName(item.title)}`;
        const filename=`${baseName}.md`; await writeFileAtomic(path.join(folder,filename),front.join("\n")); records.push({...item,html:undefined,cover,file:path.relative(opts.outputDir,path.join(folder,filename))} as ExportRecord);
        onEvent({type:"subtask",id:item.id,key:"write",status:"done"});
        onEvent({type:"subtask",id:item.id,key:"word",status:"active"});
        try{
          await this.writeWordDoc(item.title,item.url,markdown,path.join(opts.outputDir,"images"),path.join(opts.outputDir,"word"),`${baseName}.docx`);
          onEvent({type:"subtask",id:item.id,key:"word",status:"done"});
        }catch(error){
          // Word is a secondary, derived format — the Markdown archive above
          // already succeeded and stays the source of truth, so a docx
          // failure is tracked separately and doesn't flip this item's
          // overall status to "error" (matching how an image failure above
          // doesn't either).
          const message=error instanceof Error?error.message:String(error);
          wordFailures.push({itemId:item.id,title:item.title,error:message});
          onEvent({type:"subtask",id:item.id,key:"word",status:"error"});
        }
        onEvent({type:"done",id:item.id,status:"done"});
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        itemFailures.push({itemId:item.id,title:item.title,error:message}); onEvent({type:"done",id:item.id,status:"error",error:message});
      }
      await persist();
      await sleep(opts.delayMs);
    }
    await persist();
    return { sessionExpired };
  }
  private async writeManifests(outputDir:string,discovered:number,listingReport:ListingReport,records:ExportRecord[],itemFailures:ItemFailure[],skippedItems:SkippedItem[],deletedItems:DeletedItem[],imageFailures:ImageFailure[],wordFailures:WordFailure[]){
    const exportedAt=new Date().toISOString(); const summary={discovered,succeeded:records.length,failed:itemFailures.length,skipped:skippedItems.length,deleted:deletedItems.length,imageFailures:imageFailures.length,wordFailures:wordFailures.length};
    await writeJson(path.join(outputDir,"index.json"),{schemaVersion:"1.0.0",exportedAt,summary,items:records});
    // deletedItems is what lets a later run's server.ts seed
    // ExportControl.deletedItemIds and skip these permanently instead of
    // re-fetching (and re-failing) the same known-deleted article every time.
    await writeJson(path.join(outputDir,"export-report.json"),{schemaVersion:"1.0.0",exportedAt,summary,listingReport,itemFailures,imageFailures,wordFailures,skippedItems,deletedItems});
    await writeFileAtomic(path.join(outputDir,"README.md"),`# 微信公众号文章归档\n\n发现 ${summary.discovered} 项，成功 ${summary.succeeded} 项，失败 ${summary.failed} 项${summary.skipped?`，用户跳过 ${summary.skipped} 项`:""}${summary.deleted?`，作者已删除 ${summary.deleted} 项`:""}。图片失败 ${summary.imageFailures} 项，Word 转换失败 ${summary.wordFailures} 项，详情见 export-report.json。${listingReport.warning?`\n\n## 列表警告\n\n- ${listingReport.warning}\n`:"\n"}`);
  }
  // See zhi-dang's Exporter.writeWordDoc for why this is fed the body
  // markdown (not the version with YAML frontmatter prepended), and why
  // absolute paths are used for the image references here specifically.
  private async writeWordDoc(title:string,url:string,markdown:string,imagesDir:string,wordDir:string,filename:string){
    const absolute=markdown.replaceAll("](../images/",`](${imagesDir}${path.sep}`);
    const withHeader=`# ${title}\n\n${absolute}\n\n[原文链接](${url})\n`;
    const doc=await markdownDocx(withHeader);
    const buffer=await Packer.toBuffer(doc);
    await mkdir(wordDir,{recursive:true});
    await writeFile(path.join(wordDir,filename),buffer);
  }
  private async localizeImages(html:string,imageDir:string,itemId:string,extraUrls:string[]=[],onEvent?:(e:TaskEvent)=>void){
    await mkdir(imageDir,{recursive:true}); html=normalizeImageSources(html); const paths=new Map<string,string>(); const failures:ImageFailure[]=[];
    const urls=extractImageUrls(html).concat(extraUrls).filter(u=>/^https?:/.test(u));
    const uniqueUrls=[...new Set(urls)];
    onEvent?.({type:"images-list",id:itemId,urls:uniqueUrls});
    for(const url of uniqueUrls){
      onEvent?.({type:"image",id:itemId,url,status:"active"});
      try{
        let name=this.imageCache.get(url); if(!name){ const data=await this.downloadWithRetry(url); name=imageFileName(data.body,data.contentType); await writeFile(path.join(imageDir,name),data.body); this.imageCache.set(url,name); }
        const local=`images/${name}`; paths.set(url,local); html=html.split(url).join(`../${local}`);
        onEvent?.({type:"image",id:itemId,url,status:"done"});
      }
      catch(error){
        const message=error instanceof Error?error.message:String(error);
        failures.push({itemId,url,error:message}); onEvent?.({type:"image",id:itemId,url,status:"error",error:message});
      }
    }
    return {html,paths,failures};
  }
  private async downloadWithRetry(url:string){ let last:unknown; for(let attempt=1;attempt<=3;attempt++){ try{return await downloadImage(url);}catch(error){last=error;if(attempt<3)await sleep(500*2**(attempt-1));} } throw last; }
  // Confirmed against a real export: the public article page occasionally
  // fails to return #js_content on the first request (transient — the same
  // URL refetched moments later returns full content normally), so a single
  // failed fetch shouldn't immediately count an item as lost. Doesn't retry
  // SessionExpiredError (a definitive state a retry can't fix) or
  // DeletedContentError (an already-deleted article won't un-delete itself
  // on the second attempt) — retrying either would just waste requests
  // before the run correctly gives up or records the deletion.
  private async fetchBodyWithRetry(source:ContentSource,item:WeixinItem){
    let last:unknown;
    for(let attempt=1;attempt<=3;attempt++){
      try{ return await source.fetchBody(item); }
      catch(error){
        if(error instanceof SessionExpiredError||error instanceof DeletedContentError) throw error;
        last=error;
        if(attempt<3) await sleep(500*2**(attempt-1));
      }
    }
    throw last;
  }
}

type ImageFailure={itemId:string;url:string;error:string};
type ItemFailure={itemId:string;title:string;error:string};
type SkippedItem={itemId:string;title:string};
type DeletedItem={itemId:string;title:string};
type WordFailure={itemId:string;title:string;error:string};

// Naming by content hash (not source URL) means images reused across posts,
// or served from different CDN URLs with identical bytes, collapse to one
// file automatically instead of being downloaded and stored redundantly.
export function imageFileName(body:Buffer,contentType:string){ const type=contentType.toLowerCase().split(";",1)[0]; const ext:Record<string,string>={"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp","image/svg+xml":"svg","image/avif":"avif"}; const hash=createHash("sha256").update(body).digest("hex"); return `${hash}.${ext[type]??"bin"}`; }
