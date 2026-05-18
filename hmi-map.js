// Phone (JT808 terminal id) → Starkenn HMIID.
// Each value must match a row in datacollect.HMI on the platform; otherwise the
// Socket server's deviceCache will see [CACHE MISS] and no SQS routing happens.
module.exports = {
  '806072880208': 'U-N5C',
  '693071056712': 'U-N61',
  '4133159891':   'Skywonder',
  '77076779167':  'U-S61',
};
