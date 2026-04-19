'use strict';

var React = window.React;
var ReactDOM = window.ReactDOM;

module.exports = {
  jsx: function(type, props, key) {
    return React.createElement(type, props, key);
  },
  jsxs: function(type, props, key) {
    return React.createElement(type, props, key);
  },
  Fragment: React.Fragment
};
