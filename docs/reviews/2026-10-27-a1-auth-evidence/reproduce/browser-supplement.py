from pathlib import Path
from playwright.sync_api import sync_playwright
base='https://127.0.0.1:3443'
with sync_playwright() as p:
    b=p.chromium.launch(channel='msedge',headless=True)
    ctx=b.new_context(ignore_https_errors=True,viewport={'width':390,'height':844})
    pg=ctx.new_page(); pg.goto(base+'/login?returnTo=%2Flogin%3Fconfirmed%3D1')
    pg.locator('body').aria_snapshot()
    pg.get_by_label('账号',exact=True).fill('synthetic.api'); pg.get_by_label('密码',exact=True).fill('Synthetic browser password!')
    requests=[]
    def abort(route): requests.append(True); route.abort('failed')
    pg.route('**/api/auth/login',abort)
    pg.get_by_role('button',name='登录',exact=True).click()
    pg.get_by_text('网络连接失败，请重试。',exact=True).wait_for()
    pg.wait_for_timeout(1000)
    assert len(requests)==1 and pg.get_by_label('密码',exact=True).input_value()==''
    print('intercepted network failure:1request over1s, no automatic retry, password empty PASS',flush=True)
    pg.unroute('**/api/auth/login',abort)
    pg.get_by_label('密码',exact=True).fill('Synthetic browser password!')
    pg.get_by_role('button',name='登录',exact=True).click()
    pg.wait_for_url(base+'/login?confirmed=1')
    assert ctx.request.get(base+'/api/auth/session').status==200
    assert pg.get_by_label('密码',exact=True).input_value()==''
    assert pg.locator('html').evaluate('(e)=>e.scrollWidth<=innerWidth')
    pg.screenshot(path=str(Path.cwd()/'docs/reviews/2026-10-27-a1-auth-evidence/login-return-narrow.png'))
    print('real browser valid relative returnTo accepted, password empty after success, narrow screenshot PASS',flush=True)
    assert ctx.request.post(base+'/api/auth/logout',headers={'Origin':base}).status==204
    b.close()
