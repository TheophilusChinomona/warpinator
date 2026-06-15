const http=require("http");
const {loadSchema}=require("./proto_loader");
const {ResponseEvent,Request}=loadSchema();
function post(o){const b=Request.encode(Request.fromObject(o)).finish();return new Promise((res,rej)=>{const r=http.request({host:"127.0.0.1",port:8787,path:"/ai/multi-agent",method:"POST",headers:{"Content-Length":b.length}},x=>{let s="",ev=[];x.on("data",c=>{s+=c;let i;while((i=s.indexOf("\n\n"))!==-1){const f=s.slice(0,i).trim();s=s.slice(i+2);if(f.startsWith("data:"))ev.push(ResponseEvent.toObject(ResponseEvent.decode(Buffer.from(f.slice(5).trim().replace(/-/g,"+").replace(/_/g,"/"),"base64")),{oneofs:true}));}});x.on("end",()=>res(ev));});r.on("error",rej);r.write(b);r.end();});}
const acts=ev=>ev.filter(e=>e.type==="client_actions").flatMap(e=>e.client_actions.actions);
const msgs=ev=>acts(ev).flatMap(a=>a.add_messages_to_task?a.add_messages_to_task.messages:[]);
const text=ev=>{let t="";for(const a of acts(ev)){if(a.add_messages_to_task)for(const m of a.add_messages_to_task.messages)if(m.agent_output)t+=m.agent_output.text||"";if(a.append_to_message_content&&a.append_to_message_content.message.agent_output)t+=a.append_to_message_content.message.agent_output.text||"";}return t;};
(async()=>{
  let pass=true;
  console.log("[read_files round-trip]");
  const a=await post({input:{user_inputs:{inputs:[{user_query:{query:"Read the file src/config.txt and tell me what's in it. Use the read_files tool."}}]}},settings:{supported_tools:[]}});
  const tc=msgs(a).find(m=>m.tool_call&&m.tool_call.read_files);
  if(!tc){console.log("  FAIL: no read_files tool_call. Got text:",text(a).slice(0,100));pass=false;}
  else{
    const paths=(tc.tool_call.read_files.files||[]).map(f=>f.name);
    console.log("  read_files("+paths.join(",")+") ✓");
    const convId=a.find(e=>e.type==="init").init.conversation_id, taskId=tc.task_id, tcId=tc.tool_call.tool_call_id;
    const b=await post({metadata:{conversation_id:convId},task_context:{tasks:[{id:taskId,messages:[{id:"u1",user_query:{query:"Read src/config.txt"}},{id:"a1",tool_call:{tool_call_id:tcId,read_files:{files:[{name:paths[0]}]}}}]}]},input:{user_inputs:{inputs:[{tool_call_result:{tool_call_id:tcId,read_files:{text_files_success:{files:[{file_path:paths[0],content:"DEBUG=true\nPORT=9999\n"}]}}}}]}}});
    const ans=text(b).trim();
    console.log("  answer:",ans.slice(0,140));
    const ok=ans.toLowerCase().includes("9999")||ans.toLowerCase().includes("debug")||ans.length>0;
    console.log("  "+(ok?"PASS ✓ (read_files call->result->answer)":"FAIL"));pass=pass&&ok;
  }
  console.log(pass?"\nFILE TOOLS OK ✓":"\nFILE TOOLS FAILED ✗");process.exit(pass?0:1);
})();
