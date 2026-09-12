"""Manual live voice probe using the same ephemeral-token setup as the browser.
No keys, tokens, persona or private memory are printed.
"""
import asyncio, base64, json, re, time, urllib.request, pathlib, wave
import websockets

ORIGIN = 'http://127.0.0.1:8731'
def auth():
    with urllib.request.urlopen(ORIGIN) as r: page=r.read().decode()
    token=re.search(r'<meta name="jarvis-token" content="([^"]+)"',page)[1]
    req=urllib.request.Request(ORIGIN+'/api/live-token',data=b'{}',headers={
        'Origin':ORIGIN,'X-Jarvis-Token':token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req) as r: return json.load(r)

async def main():
    print('Requesting voice token',flush=True)
    config=await asyncio.to_thread(auth)
    print('Connecting native audio',flush=True)
    endpoint='wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token='+config['token']
    async with websockets.connect(endpoint,max_size=8*1024*1024) as ws:
        await ws.send(json.dumps({'setup':{
            'model':'models/'+config['model'],
            'generationConfig':{'responseModalities':['AUDIO'],'thinkingConfig':{'thinkingBudget':0},'speechConfig':{'voiceConfig':{'prebuiltVoiceConfig':{'voiceName':config['voice']}}}},
            'inputAudioTranscription':{},'outputAudioTranscription':{},
            'systemInstruction':{'parts':[{'text':config['system']}]},'tools':config['tools']}}))
        msg=json.loads(await asyncio.wait_for(ws.recv(),20))
        if 'setupComplete' not in msg: raise RuntimeError('Live setup rejected: '+str(msg.get('error',list(msg))))
        print('Native audio setup accepted',flush=True)
        start=time.monotonic();pcm=bytearray();transcript='';first=None
        await ws.send(json.dumps({'clientContent':{'turns':[{'role':'user','parts':[{'text':'صباح الخير، قولي جملة قصيرة بالمصري.'}]}],'turnComplete':True}}))
        while True:
            msg=json.loads(await asyncio.wait_for(ws.recv(),40));c=msg.get('serverContent',{})
            transcript+=c.get('outputTranscription',{}).get('text','')
            for part in c.get('modelTurn',{}).get('parts',[]):
                if part.get('inlineData',{}).get('data'):
                    if first is None:first=round((time.monotonic()-start)*1000)
                    pcm.extend(base64.b64decode(part['inlineData']['data']))
            if c.get('turnComplete'):break
        output=pathlib.Path('tests/voice-smoke.wav')
        with wave.open(str(output),'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(pcm)
        print(json.dumps({'model':config['model'],'voice':config['voice'],'first_audio_ms':first,'audio_bytes':len(pcm),'arabic_transcript':bool(re.search('[\u0600-\u06ff]',transcript)),'transcript':transcript},ensure_ascii=False),flush=True)
        await ws.send(json.dumps({'clientContent':{'turns':[{'role':'user','parts':[{'text':'افتح برنامج الرسام على الكمبيوتر باستخدام الأدوات المتاحة.'}]}],'turnComplete':True}}))
        calls=[]
        while True:
            msg=json.loads(await asyncio.wait_for(ws.recv(),40));calls=msg.get('toolCall',{}).get('functionCalls',[])
            if calls:break
            if msg.get('serverContent',{}).get('turnComplete'):break
        print(json.dumps({'requested_action_tools':[c['name'] for c in calls]}),flush=True)
        # This probe verifies routing only; do not invent a successful execution.
        for c in calls:
            await ws.send(json.dumps({'toolResponse':{'functionResponses':[{'id':c['id'],'name':c['name'],'response':{'error':'Diagnostic: execution was not requested by this probe. Do not report Paint was opened.'}}]}}))
if __name__=='__main__':asyncio.run(asyncio.wait_for(main(),90))
