'use strict';

var React = window.React;
var ReactDOM = window.ReactDOM;

module.exports = React;
exports.jsx = function(type, props, key) {
  return React.createElement(type, props, key);
};
exports.jsxs = function(type, props, key) {
  return React.createElement(type, props, key);
};
exports.Fragment = React.Fragment;
exports.useState = React.useState;
exports.useCallback = React.useCallback;
exports.useMemo = React.useMemo;
exports.useEffect = React.useEffect;
exports.useRef = React.useRef;
exports.useContext = React.useContext;
exports.useReducer = React.useReducer;
exports.useLayoutEffect = React.useLayoutEffect;
exports.useImperativeHandle = React.useImperativeHandle;
exports.useDebugValue = React.useDebugValue;
exports.useId = React.useId;
exports.useSyncExternalStore = React.useSyncExternalStore;
exports.useTransition = React.useTransition;
exports.useDeferredValue = React.useDeferredValue;
exports.useInsertionEffect = React.useInsertionEffect;
exports.useOptimistic = React.useOptimistic;
exports.useActionState = React.useActionState;
exports.use = React.use;
exports.startTransition = React.startTransition;
exports.cloneElement = React.cloneElement;
exports.createElement = React.createElement;
exports.isValidElement = React.isValidElement;
exports.Children = React.Children;
exports.Component = React.Component;
exports.PureComponent = React.PureComponent;
exports.createContext = React.createContext;
exports.createRef = React.createRef;
exports.forwardRef = React.forwardRef;
exports.memo = React.memo;
exports.lazy = React.lazy;
exports.Suspense = React.Suspense;
exports.Fragment = React.Fragment;
exports.strictMode = React.StrictMode;
exports.version = React.version;