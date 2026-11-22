// Outgoing email. Every message is stored in the outbox table. When an email
// service is configured (Worker secret BREVO_API_KEY + variable MAIL_FROM), it is
// also sent; otherwise the admin page shows it with its link so it can be passed on.

export async function sendMail(db, env, { userId = null, to, subject, text, link = null, kind = null }) {
  const body = link ? `${text}\n\n${link}\n\nHälsningar,\nTräningslogg` : `${text}\n\nHälsningar,\nTräningslogg`;
  const row = await db
    .prepare(`INSERT INTO outbox (user_id, to_email, subject, body, link, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`)
    .bind(userId, to, subject, body, link, kind)
    .first();
  if (!env.BREVO_API_KEY || !env.MAIL_FROM) return { queued: true };
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "Träningslogg" },
        to: [{ email: to }],
        subject,
        textContent: body,
      }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await db.prepare("UPDATE outbox SET sent_at = datetime('now') WHERE id = ?1").bind(row.id).run();
    return { sent: true };
  } catch (e) {
    await db.prepare("UPDATE outbox SET error = ?2 WHERE id = ?1").bind(row.id, String(e.message || e).slice(0, 300)).run();
    return { error: true };
  }
}

// Email texts (Swedish).
export const MAILS = {
  verify: (name) => ({
    subject: "Bekräfta din e-postadress – Träningslogg",
    text: `Hej ${name}!\n\nVälkommen till Träningslogg. Bekräfta din e-postadress genom att öppna länken nedan (gäller i 48 timmar).`,
  }),
  alreadyRegistered: (name) => ({
    subject: "Någon försökte registrera din adress – Träningslogg",
    text: `Hej ${name}!\n\nNågon försökte skapa ett nytt konto med din e-postadress, men du har redan ett konto. Om det var du kan du logga in som vanligt, eller återställa lösenordet via länken nedan. Om det inte var du behöver du inte göra något.`,
  }),
  reset: (name) => ({
    subject: "Återställ ditt lösenord – Träningslogg",
    text: `Hej ${name}!\n\nNågon (förhoppningsvis du) bad om att återställa lösenordet. Öppna länken nedan inom en timme för att välja ett nytt. Om det inte var du kan du strunta i det här mejlet; lösenordet ändras inte.`,
  }),
  confirmChange: (name) => ({
    subject: "Bekräfta byte av lösenord – Träningslogg",
    text: `Hej ${name}!\n\nNågon har begärt att byta lösenordet på ditt konto. Det nya lösenordet börjar gälla först när du öppnar länken nedan (gäller en timme). Om det inte var du: öppna inte länken, logga in och byt lösenord direkt, och kontakta administratören.`,
  }),
  changed: (name) => ({
    subject: "Ditt lösenord har ändrats – Träningslogg",
    text: `Hej ${name}!\n\nLösenordet till ditt konto har just ändrats och alla inloggningar har loggats ut. Om det inte var du: använd "Glömt lösenord" direkt för att ta tillbaka kontot, och kontakta administratören.`,
  }),
};
