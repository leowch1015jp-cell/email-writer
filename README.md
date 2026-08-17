# 電郵編寫助手

把口語化的中文想法寫成可以發出的電郵。支援新電郵同回覆來電，亦可錄音。

## 運行

```bash
python3 server.py
```

然後打開 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

## 金鑰

在右上角「設定」貼上金鑰，或複製 `.env.example` 為 `.env` 後填入。

- [OpenRouter](https://openrouter.ai/keys)（例如 `moonshotai/kimi-k2.5`）
- [Google Gemini](https://aistudio.google.com/apikey)

金鑰只留在本機，不要提交 `.env`。

## 使用

1. 揀電郵類型（回覆、請求、會議等）
2. 若是回覆，把對方來信貼到「要回覆的原電郵」
3. 用中文寫想法，或按「開始錄音」
4. 按「寫成電郵」，再複製主題同正文
