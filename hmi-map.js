// Phone (JT808 terminal id) → Starkenn HMIID.
// Each value must match a row in datacollect.HMI on the platform; otherwise the
// Socket server's deviceCache will see [CACHE MISS] and no SQS routing happens.
module.exports = {
  '806072880208': 'DMS_UN5C',
  '693071056712': 'DMS_UN61',
  '4133159891':   'DMS_Sky',
  '77076779167':  'DMS_US61',
};
