"""Manual diagnostic: print routing metadata and response status, never keys."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import os, json, urllib.request, urllib.error
key = server.runtime.gemini_api_key()
base = 'https://generativelanguage.googleapis.com/v1beta/openai'
body = {'model':'gemini-2.5-flash','messages':[{'role':'user','content':'Reply only OK'}]}
request = urllib.request.Request(base+'/chat/completions', data=json.dumps(body).encode(), headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
try:
    with urllib.request.urlopen(request, timeout=25) as r:
        data=json.load(r)
        print(json.dumps({'http':r.status,'model':data.get('model'),'answer':data.get('choices',[{}])[0].get('message',{}).get('content')}))
except urllib.error.HTTPError as e:
    data=json.loads(e.read())
    if isinstance(data, list): data=data[0]
    print(json.dumps({'http':e.code,'error':data.get('error',{}).get('message')}))
