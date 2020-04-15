const path = require('path');

const serverConfig = {
    entry: './index.js',
    target: 'node',
    output: {
	path: path.resolve(__dirname, 'dist'),
	filename: 'shacl.node.js'
    }
};

const clientConfig = {
    entry: './index.js',
    target: 'web',
    output: {
	path: path.resolve(__dirname, 'dist'),
	filename: 'shacl.js'
    },
    node: {
	fs: 'empty'
    }
};

module.exports = [ serverConfig, clientConfig ];
