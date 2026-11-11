-- Re-file the 86 "general" Proppy features into clearer categories (one-off). Safe to run once.
UPDATE feature_defs SET grp='outdoor'  WHERE id IN (2,10,73,491,369,95,310,567,93,123,159,304);
UPDATE feature_defs SET grp='interior' WHERE id IN (117,193,134,135,181,157,133,13,468,148,149,197);
UPDATE feature_defs SET grp='kitchen'  WHERE id IN (179,124,68,69,70,291,160,161,96);
UPDATE feature_defs SET grp='climate'  WHERE id IN (12,74,484,127,365,128,129,303,207,366,486,126,300,504,470,150);
UPDATE feature_defs SET grp='tech'     WHERE id IN (142,143,502,306,406,285,372,501,380,199,151,152,153,154,506,195,373,94);
UPDATE feature_defs SET grp='parking'  WHERE id IN (11,114,145);
UPDATE feature_defs SET grp='land'     WHERE id IN (173,370,371,155,156);
UPDATE feature_defs SET grp='utilities' WHERE id IN (162,163,164,165,292,473);
UPDATE feature_defs SET grp='location' WHERE id IN (141,166,188,202);
UPDATE feature_defs SET grp='view'     WHERE id IN (407);
