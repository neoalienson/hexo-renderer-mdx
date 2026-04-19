'use strict';

var React = window.React;
var ReactDOM = window.ReactDOM;

exports.jsx = function(type, props, key) {
  return React.createElement.apply(React, [type, props, key]);
};
exports.jsxs = exports.jsx;
exports.Fragment = React.Fragment;
