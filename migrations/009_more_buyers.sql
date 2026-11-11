-- One-off: merge "SDB - Partner" into "Partner", and mark website, partner, Arkadia and Quatru contacts as buyers.
UPDATE contacts SET origin='Partner' WHERE origin='SDB - Partner';
DELETE FROM lookups WHERE kind='origin' AND code='SDB - Partner';
DELETE FROM stats WHERE key='lookups';
UPDATE contacts SET is_buyer=1 WHERE is_buyer=0 AND origin IN ('Website','Partner','Arkadia','Quatru');
