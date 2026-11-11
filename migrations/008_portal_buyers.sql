-- One-off: contacts that came from a property portal are buyers. Existing seller flags are kept.
UPDATE contacts SET is_buyer=1 WHERE is_buyer=0 AND origin IN
 ('Kyero','Greenacres','Rightmove','Imovirtual','Idealista','APITS','A Place in the Sun','A Place in the Sun - Buying Guide','Zoopla','Mer et Demeures','List Globally','James Edition','Luxury Estate','Supercasa');
