const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Database = require("better-sqlite3");

test("real Prisma bindings, factory, structured auth errors and process restart preserve one authorization", { timeout: 60000 }, () => {
  const server = path.resolve(__dirname, "../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-prisma-"));
  const database = path.join(directory, "fixture.db");
  const env = { ...process.env, NODE_ENV: "test", DATABASE_URL: `file:${database}`,
    AI_NOVEL_RUNTIME: "desktop", AI_NOVEL_APP_DATA_DIR: directory,
    AI_NOVEL_CREDENTIALS_DIR: path.join(directory, "credentials"), LLM_DEBUG_LOG: "false",
    DOTENV_CONFIG_PATH: "/dev/null", AI_NOVEL_ACCESS_TOKEN: "isolated-app-token",
    COPILOT_TEST_SERVER: server };
  for (const key of Object.keys(env)) if (key.endsWith("_API_KEY")) delete env[key];
  const schema = spawnSync(process.execPath, [
    path.join(server, "node_modules/prisma/build/index.js"), "migrate", "diff",
    "--from-empty", "--to-schema", path.join(server, "src/prisma/schema.sqlite.prisma"), "--script",
  ], { cwd: server, env, encoding: "utf8", timeout: 30000 });
  assert.equal(schema.status, 0, schema.stderr);
  assert.ok(!/\bDROP\b|\bTRUNCATE\b/.test(schema.stdout), "fixture generation must only create a fresh schema");
  const db = new Database(database);
  try { db.exec(schema.stdout); } finally { db.close(); }
  const worker = String.raw`
    const assert=require("node:assert/strict"),path=require("node:path"),{performance}=require("node:perf_hooks");
    const root=process.env.COPILOT_TEST_SERVER,load=name=>require(path.join(root,"dist",name));
    const {prisma}=load("db/prisma");
    const {PrismaAccountStore}=load("modules/authorization/infrastructure/PrismaAccountStore");
    const {PrismaSubscriptionBindings}=load("modules/authorization/infrastructure/PrismaSubscriptionBindings");
    const {FileCredentialVault}=load("platform/security/credentials");
    const {AuthorizationService}=load("modules/authorization/application/AuthorizationService");
    const {CopilotCredentials}=load("modules/authorization/application/CopilotCredentials");
    const {SubscriptionProviders}=load("modules/authorization/application/SubscriptionProviders");
    const {SubscriptionProxy,terminalSubscriptionError,SUBSCRIPTION_BASE_URL}=load("platform/llm/subscription-proxy");
    const model={id:"chat-model",name:"Chat",transport:"chat",supportedEndpoints:["/chat/completions"],
      supportsTools:false,supportsStructuredOutput:false,reasoningEfforts:[],maxOutputTokens:1024};
    let exchanges=0,mode="ok",calls=0;
    const logs=[],originalInfo=console.info;console.info=(...args)=>logs.push(args.join(" "));
    const gateway={
      async startDevice(){return {deviceCode:"device-private",userCode:"USER-CODE",verificationUri:"https://github.com/login/device",expiresIn:600,interval:5};},
      async pollDevice(){return {token:"oauth-private"};},async user(){return {id:"123",login:"fixture-user"};},
      async exchange(){exchanges++;return {token:"short-private",expiresAt:Date.now()+3600000,origin:"https://api.githubcopilot.com"};},
      async models(){return Array.from({length:100},(_,i)=>({...model,id:i?"catalog-"+i:"chat-model"}));}
    };
    const store=new PrismaAccountStore(),vault=new FileCredentialVault(),credentials=new CopilotCredentials(store,vault,gateway);
    const authorization=new AuthorizationService(store,vault,gateway,credentials);
    const providers=new SubscriptionProviders(credentials,new PrismaSubscriptionBindings());
    const response=()=>Response.json({id:"cmpl",object:"chat.completion",created:1,model:"chat-model",
      choices:[{index:0,message:{role:"assistant",content:'{"status":"ok"}'},finish_reason:"stop"}],
      usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}});
    const proxy=new SubscriptionProxy(providers,async(_url,init)=>{
      calls++;
      if(mode==="deny")return new Response("private-detail",{status:401});
      if(JSON.parse(init.body).stream)return new Response("data: "+JSON.stringify({
        id:"cmpl",object:"chat.completion.chunk",model:"chat-model",
        choices:[{index:0,delta:{role:"assistant",content:'{"status":"ok"}'},finish_reason:"stop"}],
        usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}
      })+"\n\ndata: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
      return response();
    });
    authorization.setAuthorizedHandler(async()=>{await providers.bootstrap();await providers.refreshModels();});
    const composition=load("modules/authorization/composition");
    composition.getCopilotRuntime=()=>({authorization,credentials,providers,proxy});
    (async()=>{
      if(process.argv[1]==="create"){
        await prisma.appSetting.create({data:{key:"llm.currentSelection",value:JSON.stringify({provider:"old-provider",model:"old-model",temperature:0.7})}});
        const session=await authorization.start("first-prisma-request");await authorization.poll(session.id);
        assert.equal(authorization.session(session.id).state,"succeeded");
        assert.equal(await prisma.authorizationAccount.count(),1);
        assert.equal(await prisma.aPIKey.count(),1);
        const first=await prisma.aPIKey.findFirst();assert.equal(first.key,null);assert.equal(first.baseURL,null);
        assert.equal(first.connectionType,"copilot_subscription");assert.equal(first.model,"chat-model");
        await assert.rejects(()=>load("services/settings/RagEmbeddingModelService").getRagEmbeddingModelOptions(first.provider),
          error=>error.statusCode===400);
        await assert.rejects(()=>load("services/image/provider").generateImagesByProvider({
          provider:first.provider,model:"not-an-image-model",prompt:"fixture",size:"1024x1024",count:1
        }),error=>error.statusCode===400);
        await prisma.aPIKey.update({where:{provider:first.provider},data:{displayName:"User name",hiddenModels:'["catalog-1"]'}});
        const again=await authorization.start("second-prisma-request");await authorization.poll(again.id);
        assert.equal(await prisma.aPIKey.count(),1);
        assert.equal((await prisma.aPIKey.findFirst()).displayName,"User name");
        assert.equal(JSON.parse((await prisma.appSetting.findUnique({where:{key:"llm.currentSelection"}})).value).provider,"old-provider");
        const nativeFetch=global.fetch;let allowedOrigin="";
        global.fetch=async(input,init)=>{
          if(!allowedOrigin||!String(input).startsWith(allowedOrigin+"/"))throw new Error("Unmocked network request");
          return nativeFetch(input,init);
        };
        const listener=load("app").createApp().listen(0,"127.0.0.1");
        await require("node:events").once(listener,"listening");
        allowedOrigin="http://127.0.0.1:"+listener.address().port;
        const headers={authorization:"Bearer isolated-app-token","content-type":"application/json"};
        try{
          const created=await fetch(allowedOrigin+"/api/settings/custom-providers",{method:"POST",headers,
            body:JSON.stringify({name:"HTTP binding",connectionType:"copilot_subscription",authorizationAccountId:"github_copilot",model:"chat-model"})});
          assert.equal(created.status,201);const second=(await created.json()).data;
          const settings=(await(await fetch(allowedOrigin+"/api/settings/api-keys",{headers})).json()).data;
          const projected=settings.find(row=>row.provider===second.provider);
          assert.equal(projected.isConfigured,true);assert.equal(projected.authorizationLogin,"fixture-user");
          assert.equal(projected.currentBaseURL,"");assert.equal(projected.models.length,100);
          const choices=(await(await fetch(allowedOrigin+"/api/llm/providers",{headers})).json()).data;
          assert.equal(choices[second.provider].models.length,100);
          const setup=(await(await fetch(allowedOrigin+"/api/settings/quick-setup/status",{headers})).json()).data;
          assert.equal(setup.providers.find(row=>row.id===second.provider).configured,true);
          const unsafe=await fetch(allowedOrigin+"/api/settings/api-keys/"+second.provider,{method:"PUT",headers,
            body:JSON.stringify({key:"must-not-persist",model:"chat-model"})});
          assert.equal(unsafe.status,400);assert.equal((await unsafe.json()).code,"COPILOT_BINDING_INVALID");
          assert.equal((await prisma.aPIKey.findUnique({where:{provider:second.provider}})).key,null);
          const rag=(await(await fetch(allowedOrigin+"/api/settings/rag",{headers})).json()).data;
          const invalidEmbedding=await fetch(allowedOrigin+"/api/settings/rag",{method:"PUT",headers,
            body:JSON.stringify({...rag,embeddingProvider:first.provider,embeddingModel:"chat-model"})});
          assert.equal(invalidEmbedding.status,400);assert.match((await invalidEmbedding.json()).error,/Copilot/);
          const configured=await fetch(allowedOrigin+"/api/settings/quick-setup/complete",{method:"POST",headers,
            body:JSON.stringify({providerKind:"custom",provider:second.provider,customProviderName:"HTTP binding",model:"chat-model"})});
          assert.equal(configured.status,200);assert.equal((await configured.json()).data.status.readyForCreation,true);
          assert.equal((await prisma.aPIKey.findUnique({where:{provider:second.provider}})).connectionType,"copilot_subscription");
        }finally{
          await new Promise(resolve=>{listener.close(resolve);listener.closeAllConnections();});
          global.fetch=nativeFetch;
        }
        for(let i=2;i<20;i++)await providers.create({name:"binding-"+i,model:"chat-model"});
        const projected=await providers.projection(first);assert.equal(projected.isConfigured,true);
        const factory=load("llm/factory");
        const resolved=await factory.resolveLLMClientOptions(first.provider,{executionMode:"structured",maxTokens:2000});
        assert.equal(resolved.apiKey,undefined);assert.equal(resolved.baseURL,SUBSCRIPTION_BASE_URL);
        assert.equal(resolved.maxTokens,1024);assert.deepEqual(resolved.structuredProfile.structuredModes,["prompt_only"]);
        const usageBeforeFactory=await prisma.llmInvocationUsageRecord.count();
        const text=await factory.createLLMFromResolvedOptions(resolved).invoke("hello");
        assert.equal(text.content,'{"status":"ok"}');
        assert.equal(await prisma.llmInvocationUsageRecord.count(),usageBeforeFactory+1,"one SDK invocation must produce one usage record");
        const compatibility=load("llm/compatibility");
        const identity={provider:first.provider,model:"chat-model",baseURL:SUBSCRIPTION_BASE_URL};
        const originalProfile=await compatibility.loadCapability(identity);
        await compatibility.saveCapability(identity,{...originalProfile,source:"user_override",structuredModes:["tool_calling","prompt_only"]});
        assert.equal((await factory.resolveLLMClientOptions(first.provider)).subscriptionModel.supportsTools,true);
        await compatibility.saveCapability(identity,{...originalProfile,source:"user_override",structuredModes:["prompt_only"]});
        const selectionBefore=await prisma.appSetting.findUnique({where:{key:"llm.currentSelection"}});
        const plainBase=[],proxied=[];
        const fetcher=proxy.fetchFor(first.provider,"chat-model");
        for(let i=0;i<110;i++){
          let start=performance.now();await response().text();if(i>=10)plainBase.push(performance.now()-start);
          start=performance.now();const r=await fetcher(SUBSCRIPTION_BASE_URL+"/chat/completions",{
            method:"POST",body:JSON.stringify({model:"chat-model",messages:[{role:"user",content:"hello"}]})});
          await r.text();if(i>=10)proxied.push(performance.now()-start);
        }
        const percentile=values=>values.sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
        const baseline=percentile(plainBase),proxyP95=percentile(proxied);
        originalInfo(JSON.stringify({performance:{bindings:20,models:100,samples:100,baselineP95Ms:baseline,proxyP95Ms:proxyP95,addedP95Ms:proxyP95-baseline}}));
        await prisma.appSetting.upsert({where:{key:"structuredFallback.enabled"},create:{key:"structuredFallback.enabled",value:"true"},update:{value:"true"}});
        await prisma.appSetting.upsert({where:{key:"structuredFallback.provider"},create:{key:"structuredFallback.provider",value:"paid-provider"},update:{value:"paid-provider"}});
        await prisma.appSetting.upsert({where:{key:"structuredFallback.model"},create:{key:"structuredFallback.model",value:"paid-model"},update:{value:"paid-model"}});
        mode="deny";const before=calls;
        const {z}=require(path.join(root,"node_modules/zod"));
        await assert.rejects(()=>load("llm/structuredInvoke").invokeStructuredLlmDetailed({
          provider:first.provider,model:"chat-model",label:"subscription-fixture",schema:z.object({status:z.literal("ok")}),
          messages:[new (require(path.join(root,"node_modules/@langchain/core/messages")).HumanMessage)("hello")],
          maxTokens:64,maxRepairAttempts:1
        }),error=>terminalSubscriptionError(error)?.code==="COPILOT_AUTH_REQUIRED");
        assert.equal(calls,before+1,"authorization errors must not repeat or switch providers");
        assert.equal(await prisma.llmInvocationUsageRecord.count(),usageBeforeFactory+2,"one failed physical call must not duplicate usage records");
        assert.deepEqual(await prisma.appSetting.findUnique({where:{key:"llm.currentSelection"}}),selectionBefore);
        assert.ok(!logs.join("\n").includes("oauth-private"));assert.ok(!logs.join("\n").includes("short-private"));
        assert.ok(logs.some(line=>line.includes("subscription.request")));
      }else{
        const access=await credentials.access();assert.equal(access.token,"short-private");assert.equal(exchanges,1);
        assert.equal(await prisma.authorizationAccount.count(),1);assert.equal(await prisma.aPIKey.count(),20);
        const row=await prisma.aPIKey.findUnique({where:{provider:"custom_github_copilot"}});
        assert.equal(row.displayName,"User name");assert.equal(row.hiddenModels,'["catalog-1"]');
        await authorization.logout((await store.get()).credentialRevision);
        assert.equal((await providers.projection(row)).isConfigured,false);
        assert.equal(await prisma.aPIKey.count(),20);
      }
      proxy.close();authorization.close();await prisma.$disconnect();console.info=originalInfo;
    })().catch(async error=>{console.info=originalInfo;console.error(error);proxy.close();authorization.close();await prisma.$disconnect();process.exitCode=1;});
  `;
  for (const mode of ["create", "restart"]) {
    const result = spawnSync(process.execPath, ["-e", worker, mode], { cwd: server, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `${mode}\n${result.stderr}\n${result.stdout}`);
    if (result.stdout.trim()) console.log(result.stdout.trim());
  }
});
