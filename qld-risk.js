// Queensland Department of Education risk levels for curriculum activities,
// from "Managing risks in school curriculum activities" procedure
// (version 6.7, effective 10/09/2026). PracReady uses them for every CARA.
// Activities are rated on their INHERENT risk (before control measures);
// that level decides approval and consent. The risk remaining after
// controls (residual) is recorded separately so the approver can judge
// whether the activity is justified. Re-check against the Policy and
// Procedure Register when the procedure is updated.

const SOURCE = {
  title: 'Queensland Department of Education — Managing risks in school curriculum activities procedure (v6.7, effective 10/09/2026)',
  url: 'https://ppr.qed.qld.gov.au/pp/managing-risks-in-school-curriculum-activities-procedure',
};

const LEVELS = {
  Low: {
    meaning: 'Little chance of an incident occurring that would result in an injury.',
    approval: 'Low: record the risk level and control measures in teacher planning. No separate approval is required.',
  },
  Medium: {
    meaning: 'Some chance of an incident occurring which would result in an injury requiring first aid.',
    approval: 'Medium: the HOD, HOSES or HOC must give documented approval. Parent/carer consent should be considered.',
  },
  High: {
    meaning: 'Inherently dangerous: a high chance of a serious incident with major consequences (e.g. injury needing specialist treatment or hospitalisation).',
    approval: 'High: the principal (or delegate) must give documented approval of this CARA. Parent/carer consent is strongly recommended as a condition of approval.',
  },
  Extreme: {
    meaning: 'Inherently dangerous: a high chance of a serious incident with critical consequences (e.g. permanent disability or loss of life).',
    approval: 'Extreme: the principal must give documented approval of this CARA. Parent/carer consent is mandatory as a condition of approval.',
  },
};

module.exports = { SOURCE, LEVELS };
