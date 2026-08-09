const noRecordStringUnknown = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require domain types instead of Record<string, unknown>'
    },
    messages: {
      useDomainType:
        'Replace this generic record with a domain type, and parse the data as early and as close to its I/O boundary as possible.'
    },
    schema: []
  },
  create(context) {
    return {
      TSTypeReference(node) {
        const typeArguments = node.typeArguments?.params

        if (
          node.typeName.type === 'Identifier' &&
          node.typeName.name === 'Record' &&
          typeArguments?.length === 2 &&
          typeArguments[0].type === 'TSStringKeyword' &&
          typeArguments[1].type === 'TSUnknownKeyword'
        ) {
          context.report({ messageId: 'useDomainType', node })
        }
      }
    }
  }
}

export default {
  meta: {
    name: 'treeport'
  },
  rules: {
    'no-record-string-unknown': noRecordStringUnknown
  }
}
