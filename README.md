# Elsisy Security System

## التشغيل
1. اعمل `.env` من `.env.example`.
2. حط Token البوت.
3. حط ID روم الحماية.
4. حط ID السيرفر وروم اللوج.
5. حط ID الرول المسموح لها باستخدام `/security` والأزرار.
6. `npm install`
7. `node index.js`

## المطلوب من البوت
### في سيرفر الحماية
- View Channel
- Send Messages
- Embed Links
- Manage Messages
- Moderate Members
- Kick Members
- Ban Members

### Intents
فعّل من Discord Developer Portal:
- Message Content Intent
- Server Members Intent

## النظام
- أي رسالة من شخص في روم الحماية: Timeout حسب `TIMEOUT_MINUTES` + حذف الرسالة.
- يتم حذف آخر رسائل الشخص داخل رومات السيرفر حتى `MAX_DELETE_MESSAGES`.
- لو العضو أعلى/مساوي للبوت أو Server Owner: البوت لا يقدر يعمل Timeout، لكن يحذف الرسالة ويسجل أن العضو أعلى من البوت.
- الصور/GIF تظهر في اللوج، وباقي المرفقات تظهر كروابط.
- `/security` يرسل Embed الحماية داخل روم الحماية، ومتاح للرول المحددة في `SECURITY_ROLE_ID` أو Administrator.
- لوج الحماية يحتوي أزرار Revoke / Kick / BAN.
- الضغط على زر يظهر تأكيد خاص للشخص الذي ضغط فقط.
- بعد التأكيد يتم تسجيل العملية في DM الخاص بمنفذها.

## ملاحظة Discord
البوت لا يستطيع تنفيذ Moderation على Server Owner أو عضو رتبته أعلى/مساوية لأعلى رتبة للبوت.
