-- Fictional local fixtures. Only run through dev:seed with wrangler.local.jsonc.
INSERT OR IGNORE INTO domains(domain,remark) VALUES ('example.test','本地开发域名'),('mail.example.test','项目测试邮箱');
INSERT OR IGNORE INTO groups(id,name,color) VALUES (2,'开发工具','#0071e3');
INSERT OR IGNORE INTO tags(id,name,color) VALUES (1,'常用','#008844');
INSERT OR IGNORE INTO accounts(id,email,password,client_id,refresh_token,remark,group_id,auth_status,last_error,last_error_code) VALUES
(1,'workspace@outlook.com','local-example','11111111-2222-4333-8444-555555555555','M.FICTIONAL_LOCAL_ONLY_REFRESH_TOKEN_0123456789','开发服务与日常工具',2,'healthy','',''),
(2,'reconnect@hotmail.com','','11111111-2222-4333-8444-555555555555','M.FICTIONAL_LOCAL_ONLY_REFRESH_TOKEN_0123456789','需要更新授权的示例账号',1,'reauth_required','授权已失效，请重新授权','invalid_grant'),
(3,'pending@outlook.com','','11111111-2222-4333-8444-555555555555','M.FICTIONAL_LOCAL_ONLY_REFRESH_TOKEN_0123456789','刚导入的邮箱',1,'unchecked','','');
INSERT OR IGNORE INTO account_tags(account_id,tag_id) VALUES(1,1);
INSERT INTO platform_vault(platform_name,platform_url,account_email,email_source,username,password,category,remark)
SELECT 'Example Service ' || value,'https://example.com','project' || value || '@example.test','cf_domain','tester-' || value,'local-example','开发服务','本地测试数据'
FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35]') j
WHERE NOT EXISTS(SELECT 1 FROM platform_vault v WHERE v.platform_name='Example Service ' || j.value);
INSERT INTO platform_vault(platform_name,account_email,email_source,username,category)
SELECT 'Microsoft Workspace','workspace@outlook.com','outlook','workspace@outlook.com','微软生态' WHERE NOT EXISTS(SELECT 1 FROM platform_vault WHERE platform_name='Microsoft Workspace');
INSERT OR IGNORE INTO temp_mailboxes(address,prefix,domain,is_permanent,remark) VALUES ('reading@example.test','reading','example.test',1,'邮件阅读示例');
INSERT INTO cf_inbox_mails(message_id,recipient,sender,sender_name,subject,text_content,html_content,verification_code,is_protected)
SELECT 'local-welcome','reading@example.test','auth@example.test','Example Service','欢迎使用工作邮箱 · 验证码 246810','你的登录验证码是 246810。此邮件只用于本地界面测试。','<h2>欢迎使用工作邮箱</h2><p>你的登录验证码是 <strong>246810</strong>。</p><p>此邮件只用于本地界面测试。</p>','246810',1
WHERE NOT EXISTS(SELECT 1 FROM cf_inbox_mails WHERE message_id='local-welcome');
