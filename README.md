# 葡萄个人助手家庭版

家庭医生咨询 + 多账户私有对话。默认通过 Cursor Cloud Agents API 调用 **grok-4.5**。

## 本地启动

```bash
cd /Users/Wezhang/workspace/doctor
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 填入 CURSOR_API_KEY 等
./scripts/run.sh
```

浏览器打开：http://127.0.0.1:8765

## 账户

葡萄爸爸 / 葡萄 / 葡萄妈妈 / 葡萄爷爷 / 葡萄奶奶 / 葡萄外公 / 葡萄外婆

首次登录设置密码，之后需密码进入。各账户会话彼此隔离，数据存于 `data/`。

## 部署

见 `scripts/deploy.sh`。
