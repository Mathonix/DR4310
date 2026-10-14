import {describe,expect,it} from "vitest";
import {CoggingCalibration,CoggingFit,cogCrc,validateCogMap,type CogDriver,type CogMap} from "../src/cogging-calibration";
const tau=2*Math.PI, binding={zero:.134657,dir:1,pp:14};
const makeMap=():CogMap => { const current_ma=Array.from({length:512},(_,i)=>Math.round(30*Math.sin(i*tau/512))); return {type:"dr4310-cogging",version:1,angle:"raw_encoder_rad",binding,motor_id:2,current_ma,crc32:cogCrc(current_ma)}; };
function rig() {
  let now=0, speed=0, angle=6.2, names=["IdRef","Id","IqRef","Iq","Vd","Vq","Vbus","Vsat","Omega","DutyA","DutyB","DutyC","CurKp","CurKi","Fault","Mode"], rate=100;
  let listener: ((f:Float32Array,t:number)=>void)|null=null, live=true, fail="", injected=false;
  let map=makeMap(), flash=makeMap(), staging:number[]=[], mode=0;
  const p:Record<string,number>={IQ_LIM:1.9,OL_EN:1,SPD_RAMP_MS:250,TIMEOUT_MS:0,TELEM:1,COG_EN:1,COG_GAIN:1,COG_LIM:.2};
  let savedParams={...p};
  const commands:string[]=[];
  const driver:CogDriver={current:()=>live,now:()=>now,progress:()=>{},
    params:async()=>({...p}),channels:()=>{},subscribe:f=>{listener=f;return()=>{listener=null;};},
    sleep:async ms=> {
      now+=ms;
      if(mode===2 && listener && p.TELEM) {
        angle=((angle+speed*ms/1000)%tau+tau)%tau;
        const f=new Float32Array(16); f[0]=angle;f[1]=.025*Math.sin(angle*12)+.012*Math.sign(speed)+.008;
        f[2]=f[1]!;f[3]=speed;f[4]=0;f[5]=mode;f[6]=12.4;f[9]=0;
        listener(f,now);
      }
    },
    command:async line=> {
      const cmd=line.trim();commands.push(cmd);
      if(fail && cmd.startsWith(fail) && !injected){injected=true;throw new Error("injected failure");}
      const [key,...args]=cmd.split(/\s+/); let kv:Record<string,string>={},text="";
      if(key==="STOP"){mode=0;speed=0;}
      if(key==="INFO") kv={fw:"DR4310",ver:"3.3.0",id:"2",calib:"1",fault:"0",latched:"0",vbus:"12.4",run:mode?"SPEED":"IDLE",drv:mode?"1":"0",ae:"0"};
      if(key==="COG") {
        if(args[0]==="INFO")kv={size:"512",zero:String(binding.zero),dir:"1",pp:"14",valid:"1",match:"1",enabled:String(p.COG_EN),crc:"0x"+map.crc32};
        if(args[0]==="GET")kv={index:args[1]!,ma:String(map.current_ma[Number(args[1])])};
        if(args[0]==="BEGIN"){staging=[];p.COG_EN=0;}
        if(args[0]==="SET")args.slice(2).forEach((v,i)=>staging[Number(args[1])+i]=Number(v));
        if(args[0]==="COMMIT"){map={...map,current_ma:[...staging],crc32:cogCrc(staging)};}
      }
      if(key==="SET")p[args[0]!]=Number(args[1]);
      if(key==="TCH"){if(args.length)names=args;text=names.join(",");}
      if(key==="TRATE"){if(args.length)rate=Number(args[0]);kv.hz=String(rate);}
      if(key==="SPD"){mode=2;speed=Number(args[0])*tau/60;}
      if(key==="SAVE"){flash=structuredClone(map);savedParams={...p};}
      if(key==="RELOAD"){map=structuredClone(flash);Object.assign(p,savedParams);}
      return {kv,text};
    },
  };
  const engine=new CoggingCalibration(driver);
  return {engine,driver,commands,p,get mode(){return mode;},get map(){return map;},get now(){return now;},set fail(v:string){fail=v;},disconnect(){live=false;}};
}
describe("browser cogging calibration",()=> {
  it("separates directional friction, removes DC and covers every cyclic knot",()=> {
    const fit=new CoggingFit();
    for(const sign of [1,-1])for(let pass=0;pass<4;pass++)for(let i=0;i<512;i++)fit.add(sign,i*tau/512,.03*Math.sin(i*tau/512)+sign*.01+.007);
    const map=fit.finish(binding,2,.2); expect(map.current_ma).toEqual(makeMap().current_ma); expect(map.quality?.min_samples_per_bin).toBe(4);
    expect(()=>new CoggingFit().finish(binding,2,.2)).toThrow(/样本不足/);
  });
  it("rejects changed files, DC bias and invalid device identity",()=> {
    const map=makeMap(); expect(validateCogMap(map).crc32).toBe(map.crc32);
    map.current_ma[0]=32;expect(()=>validateCogMap(map)).toThrow(/CRC/);
    expect(()=>validateCogMap({...makeMap(),motor_id:0})).toThrow();
    const biased=Array(512).fill(30);expect(()=>validateCogMap({...makeMap(),current_ma:biased,crc32:cogCrc(biased)})).toThrow(/直流/);
  });
  it("runs both directions over wraps, restores all temporary settings and never saves calibration automatically",async()=> {
    const r=rig(),before={...r.p};const map=await r.engine.calibrate({speed:.2,currentLimit:.2,turns:2});
    expect(map.quality!.min_samples_per_bin).toBeGreaterThanOrEqual(4);expect(map.quality!.peak_a).toBeCloseTo(.025,2);
    expect(r.commands.filter(c=>c.startsWith("SPD ")).length).toBe(2);expect(r.commands).not.toContain("SAVE");expect(r.mode).toBe(0);expect(r.p).toEqual(before);expect(r.engine.active).toBe(false);
  });
  it("stops on cancellation and restores timeout only after stopping",async()=> {
    const r=rig(),before={...r.p},sleep=r.driver.sleep;
    r.driver.sleep=async ms=> {await sleep(ms);if(r.now>3500)r.engine.cancel("test stop");};
    await expect(r.engine.calibrate({speed:.2,currentLimit:.2,turns:2})).rejects.toThrow("test stop");
    expect(r.mode).toBe(0);expect(r.p).toEqual(before);const index=r.commands.lastIndexOf("SET TIMEOUT_MS 0");expect(r.commands.slice(0,index)).toContain("STOP");
  });
  it("does not write cleanup commands into a disconnected/replaced serial session",async()=> {
    const r=rig(),sleep=r.driver.sleep;
    r.driver.sleep=async ms=> {await sleep(ms);if(r.now>3500)r.disconnect();};
    await expect(r.engine.calibrate({speed:.2,currentLimit:.2,turns:2})).rejects.toThrow(/连接/);
    expect(r.commands).not.toContain("SET TIMEOUT_MS 0");expect(r.p.TIMEOUT_MS).toBe(1000);
  });
  it("rejects telemetry loss and restores safe idle",async()=> {
    const r=rig();r.driver.subscribe=()=>()=>{};
    await expect(r.engine.calibrate({speed:.2,currentLimit:.2,turns:2})).rejects.toThrow(/遥测中断/);expect(r.mode).toBe(0);expect(r.p.TIMEOUT_MS).toBe(0);
  });
  it("uploads all 512 points, backs up the original, verifies flash and keeps compensation disabled",async()=> {
    const r=rig();await r.engine.upload(makeMap());expect(r.engine.backup?.crc32).toBe(makeMap().crc32);
    expect(r.commands.filter(c=>c.startsWith("COG SET ")).length).toBe(32);expect(r.commands).toContain("SAVE");expect(r.commands).toContain("RELOAD");expect(r.p.COG_EN).toBe(0);expect(r.mode).toBe(0);
  });
  it("does not overwrite the map of a different motor",async()=> {
    const r=rig();await expect(r.engine.upload({...makeMap(),motor_id:3})).rejects.toThrow(/不匹配/);expect(r.commands).not.toContain("COG BEGIN");expect(r.commands).not.toContain("SAVE");
  });
  it("rolls an interrupted upload back to the old map without writing flash",async()=> {
    const r=rig();r.fail="COG SET 32 ";await expect(r.engine.upload(makeMap())).rejects.toThrow(/injected/);
    expect(r.map.crc32).toBe(makeMap().crc32);expect(r.commands).not.toContain("SAVE");expect(r.p.COG_EN).toBe(1);expect(r.mode).toBe(0);
  });
  it("enables only a matching valid map and clears the operation lock after failure",async()=> {
    const r=rig();await r.engine.enable();expect(r.p.COG_EN).toBe(1);expect(r.mode).toBe(0);expect(r.engine.active).toBe(false);
    r.fail="SAVE";await expect(r.engine.enable()).rejects.toThrow();expect(r.engine.active).toBe(false);expect(r.p.COG_EN).toBe(0);
  });
});
