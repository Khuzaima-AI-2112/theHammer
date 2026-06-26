'use strict';

const ROLE_HIERARCHY = {
  admin: 4,
  analyst: 3,
  instructional_designer: 2,
  user: 1
};

const VALID_ROLES = Object.keys(ROLE_HIERARCHY);

module.exports = {
  ROLE_HIERARCHY,
  VALID_ROLES
};
