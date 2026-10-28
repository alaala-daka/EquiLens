from pathlib import Path
from datetime import datetime, timedelta, timezone
import ipaddress, ssl, http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
root=Path(__file__).parent
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'A1 isolated localhost test')])
now=datetime.now(timezone.utc)
cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256())
(root/'task8-localtls-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
(root/'task8-localtls-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
hop={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length'}
class Proxy(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args): pass
    def forward(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        headers={k:v for k,v in self.headers.items() if k.lower() not in hop}
        conn=http.client.HTTPConnection('127.0.0.1',3187,timeout=30)
        try:
            conn.request(self.command,self.path,body=body,headers=headers)
            response=conn.getresponse(); data=response.read()
            self.send_response(response.status)
            for k,v in response.getheaders():
                if k.lower() not in hop: self.send_header(k,v)
            self.send_header('Content-Length',str(len(data))); self.end_headers()
            if self.command!='HEAD': self.wfile.write(data)
        finally: conn.close()
    do_GET=do_HEAD=do_POST=do_PUT=do_PATCH=do_DELETE=do_OPTIONS=forward
server=ThreadingHTTPServer(('127.0.0.1',3443),Proxy)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root/'task8-localtls-cert.pem',root/'task8-localtls-key.pem')
server.socket=context.wrap_socket(server.socket,server_side=True)
print('Synthetic local TLS proxy ready at127.0.0.1:3443; self-signed certificate; no header rewriting',flush=True)
try: server.serve_forever()
except KeyboardInterrupt: pass
finally: server.server_close()
