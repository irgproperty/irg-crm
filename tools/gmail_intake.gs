// IRG CRM portal-enquiry intake. Runs inside Google Apps Script on the Gmail account that portugal@ forwards to.
// Script properties needed: CRM_URL (e.g. https://irg-crm.irgproperty-crm.workers.dev), SITE_KEY.
function processPortalEmails() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('CRM_URL') + '/api/public/inbound', key = props.getProperty('SITE_KEY');
  const done = GmailApp.getUserLabelByName('crm-done') || GmailApp.createLabel('crm-done');
  const threads = GmailApp.search('in:anywhere newer_than:14d -label:crm-done', 0, 30);
  for (const th of threads) {
    let ok = true;
    for (const m of th.getMessages()) {
      try {
        const res = UrlFetchApp.fetch(url, {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-site-key': key },
          payload: JSON.stringify({ from: m.getFrom(), replyTo: m.getReplyTo(), subject: m.getSubject(), text: m.getPlainBody() }),
        });
        if (res.getResponseCode() !== 200) ok = false;
      } catch (e) { ok = false; }
    }
    if (ok) th.addLabel(done);          // on failure it is retried on the next run
  }
}
