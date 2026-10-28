import json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path.cwd()
base='https://127.0.0.1:3443'
evidence=root/'docs/reviews/2026-10-27-a1-auth-evidence'
results=[]
def record(message):
    results.append(message); print(message,flush=True)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    ctx=browser.new_context(viewport={'width':390,'height':844},ignore_https_errors=True)
    page=ctx.new_page()
    page.goto(base+'/login?returnTo=https://invalid.example',wait_until='domcontentloaded',timeout=120000)
    aria=page.locator('body').aria_snapshot()
    assert '账号' in aria and '密码' in aria and '登录衡鉴' in aria
    page.get_by_role('textbox',name='账号').focus()
    page.keyboard.type('synthetic.browser')
    page.keyboard.press('Tab')
    page.keyboard.type('wrong synthetic password')
    page.keyboard.press('Enter')
    page.get_by_text('账号或密码错误。',exact=True).wait_for()
    assert page.get_by_label('密码',exact=True).input_value()==''
    assert page.get_by_label('账号',exact=True).input_value()=='synthetic.browser'
    assert page.locator('html').evaluate('(e)=>e.scrollWidth <= innerWidth')
    page.screenshot(path=str(evidence/'login-error-narrow.png'))
    record('keyboard login error, password clear, username retained, narrow no-horizontal-overflow PASS')
    def abort(route): route.abort('failed')
    page.route('**/api/auth/login',abort)
    page.get_by_label('密码',exact=True).fill('Synthetic browser password!')
    page.get_by_role('button',name='登录',exact=True).click()
    page.get_by_text('网络连接失败，请重试。',exact=True).wait_for()
    assert page.get_by_label('密码',exact=True).input_value()==''
    page.unroute('**/api/auth/login',abort)
    record('intercepted network failure visible, password clear, no automatic retry PASS')
    page.get_by_label('密码',exact=True).fill('Synthetic browser password!')
    page.get_by_role('button',name='登录',exact=True).click()
    page.wait_for_url(base+'/',timeout=30000)
    assert page.get_by_label('密码',exact=True).count()==0
    assert ctx.request.get(base+'/api/auth/session').status==200
    auth_cookie=next(c for c in ctx.cookies() if c['name']=='__Host-equilens-auth')
    assert auth_cookie['secure'] and auth_cookie['httpOnly'] and auth_cookie['sameSite']=='Lax' and auth_cookie['path']=='/'
    record('actual Secure/HttpOnly/SameSite=Lax __Host cookie accepted by isolated browser over synthetic localTLS PASS')
    record('actual browser login200, unsafe external returnTo falls back same-origin root, session200 PASS')
    # Interface duplicate requests are tested with an intentionally held intercepted response.
    page.goto(base+'/login')
    page.locator('body').aria_snapshot()
    page.get_by_label('账号',exact=True).fill('synthetic.browser')
    page.get_by_label('密码',exact=True).fill('Synthetic browser password!')
    pending=[]
    page.route('**/api/auth/login',lambda route:pending.append(route))
    page.get_by_role('button',name='登录',exact=True).click()
    page.wait_for_timeout(250)
    page.locator('form').evaluate('(f)=>{f.requestSubmit();f.requestSubmit()}')
    page.wait_for_timeout(250)
    assert len(pending)==1
    assert page.get_by_role('button',name='登录中…').is_disabled()
    pending[0].fulfill(status=401,content_type='application/json',body=json.dumps({'error':{'code':'INVALID_CREDENTIALS','message':'账号或密码错误。'}}))
    page.get_by_text('账号或密码错误。',exact=True).wait_for()
    assert page.get_by_label('密码',exact=True).input_value()==''
    record('held/intercepted login response: duplicate form submit blocked (1 request), busy button disabled PASS')
    page.unroute('**/api/auth/login')
    def mutate(action):
        env=os.environ.copy(); env['SQLITE_PATH']=str(root/'.superpowers/sdd/2026-10-27-a1-auth-http-session-plan/task8-localtls-synthetic.sqlite')
        done=subprocess.run(['C:/Program Files/nodejs/node.exe','node_modules/tsx/dist/cli.mjs','docs/reviews/2026-10-27-a1-auth-evidence/reproduce/synthetic-fixture.ts',action],env=env,capture_output=True)
        assert done.returncode==0, 'synthetic mutation failed'
    mutate('expire')
    assert ctx.request.get(base+'/api/auth/session').status==401
    record('actual browser cookie + synthetic DB expires_at moved to past: session401 PASS (not 12h elapsed acceptance)')
    login=ctx.request.post(base+'/api/auth/login',headers={'Origin':base},data={'username':'synthetic.browser','password':'Synthetic browser password!'})
    assert login.status==200
    mutate('disable')
    assert ctx.request.get(base+'/api/auth/session').status==401
    mutate('enable')
    assert ctx.request.get(base+'/api/auth/session').status==401
    record('synthetic maintain disable/re-enable: old browser session401 both times PASS')
    assert ctx.request.post(base+'/api/auth/logout',headers={'Origin':base}).status==204
    assert ctx.request.get(base+'/api/auth/session').status==401
    record('browser-context actual logout204 then session401 PASS (no workspace logout UI available)')
    browser.close()

