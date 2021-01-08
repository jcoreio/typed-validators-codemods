import * as t from '@babel/types'
import template from '@babel/template'
import traverse from '@babel/traverse'
import convertTSRecordType, { isTSRecordType } from './TSRecordType'
import convertObjectTypeAnnotation from './ObjectTypeAnnotation'
import NodeConversionError from '../NodeConversionError'
import convertTSTypeLiteral from './TSTypeLiteral'
import { NodePath } from '@babel/traverse'
import { builtinClasses } from './builtinClasses'
import { TSBindingVisitors } from '../ts/TSBindingVisitors'
import getReifiedType from './getReifiedType'
import once from '../util/once'
import resolveImportSource from './resolveImportSource'
import moveImportKindToSpecifiers from './moveImportKindToSpecifiers'
import areReferencesEqual from './areReferencesEqual'
import getKey from './getKey'
import convertUtilityFlowType from './convertUtilityFlowType'
import moveLeadingCommentsToNextSibling from './moveCommentsToNextSibling'

const templates = {
  importTypedValidators: template.statement`import * as T from 'typed-validators'`,
  importValidation: template.statement`import { Validation as LOCAL } from 'typed-validators'`,
  undefined: template.expression`T.undefined()`,
  any: template.expression`T.any()`,
  unknown: template.expression`T.unknown()`,
  null: template.expression`T.null()`,
  number: template.expression`T.number()`,
  numberLiteral: template.expression`T.number(VALUE)`,
  string: template.expression`T.string()`,
  stringLiteral: template.expression`T.string(VALUE)`,
  boolean: template.expression`T.boolean()`,
  booleanLiteral: template.expression`T.boolean(VALUE)`,
  symbol: template.expression`T.symbol()`,
  nullishOr: template.expression`T.nullishOr(TYPE)`,
  array: template.expression`T.array(TYPE)`,
  tuple: template.expression(`%%T%%.tuple(%%TYPES%%)`),
  oneOf: template.expression(`%%T%%.oneOf(%%TYPES%%)`),
  allOf: template.expression(`%%T%%.allOf(%%TYPES%%)`),
  instanceOf: template.expression`T.instanceOf(() => CLASS)`,
  ref: template.expression`T.ref(() => TYPE)`,
  alias: template.statement`const ID = T.alias(NAME, TYPE)`,
}

type GetValidatorName = (typeName: string) => string

type Resolve = (file: string, options: { basedir: string }) => Promise<string>
type ParseFile = (file: string) => Promise<t.File>

type ConvertedTypeReference = {
  converted:
    | t.Identifier
    | t.StringLiteral
    | t.QualifiedTypeIdentifier
    | t.TSQualifiedName
  kind: 'class' | 'alias' | 'any'
}

export class ConversionContext {
  public readonly t: t.Identifier
  public readonly getValidatorName: GetValidatorName
  public readonly resolve: Resolve
  public readonly defaultExact: boolean
  private readonly _parseFile: ParseFile
  private fileContexts: Map<string, FileConversionContext> = new Map()
  public fileASTs: Map<string, t.File> = new Map()

  constructor({
    typedValidatorsIdentifier = t.identifier('t'),
    getValidatorName = (typeName: string): string => typeName + 'Type',
    resolve,
    parseFile,
    defaultExact = true,
  }: {
    parseFile: ParseFile
    resolve: Resolve
    typedValidatorsIdentifier?: t.Identifier
    getValidatorName?: GetValidatorName
    defaultExact?: boolean
  }) {
    this.t = typedValidatorsIdentifier
    this.getValidatorName = getValidatorName
    this.resolve = resolve
    this._parseFile = parseFile
    this.defaultExact = defaultExact
  }

  parseFile = async (file: string): Promise<t.File> => {
    let ast = this.fileASTs.get(file)
    if (ast) return ast
    ast = await this._parseFile(file)
    this.fileASTs.set(file, ast)
    return ast
  }

  forFile(file: string): FileConversionContext {
    const existing = this.fileContexts.get(file)
    if (existing) return existing
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const result = new FileConversionContext({ context: this, file })
    this.fileContexts.set(file, result)
    return result
  }
}

export class FileConversionContext {
  public readonly context: ConversionContext
  public readonly file: string
  private convertedTypeReferences: Map<
    t.Node,
    ConvertedTypeReference
  > = new Map()

  constructor({ context, file }: { context: ConversionContext; file: string }) {
    this.context = context
    this.file = file
  }

  get getValidatorName(): GetValidatorName {
    return this.context.getValidatorName
  }
  get parseFile(): ParseFile {
    return this.context.parseFile
  }
  get defaultExact(): boolean {
    return this.context.defaultExact
  }

  formatLocation(node: t.Node | NodePath): string {
    if (node instanceof NodePath) return this.formatLocation(node.node)
    const { loc } = node
    if (!loc) throw new Error('missing node.loc')
    return `(${this.file ? this.file + ' ' : ''}${loc.start.line}:${
      loc.start.column
    })`
  }

  getValidatorIdentifier(type: string | t.Identifier): t.Identifier {
    if (typeof type === 'string')
      return t.identifier(this.getValidatorName(type))
    return t.identifier(this.getValidatorName(type.name))
  }

  async processFile(): Promise<void> {
    const ast = await this.parseFile(this.file)
    const reifyCalls: (
      | NodePath<t.TypeCastExpression>
      | NodePath<t.TSAsExpression>
    )[] = []
    traverse(ast, {
      TypeCastExpression: (path: NodePath<t.TypeCastExpression>) => {
        if (getReifiedType(path)) {
          reifyCalls.push(path)
          path.skip()
        }
      },
      TSAsExpression: (path: NodePath<t.TSAsExpression>) => {
        if (getReifiedType(path)) {
          reifyCalls.push(path)
          path.skip()
        }
      },
    })
    for (const path of reifyCalls) {
      await this.replaceReifyCall(path)
    }
    traverse(ast, {
      ImportDeclaration: (path: NodePath<t.ImportDeclaration>) => {
        if (path.node.source.value === 'flow-runtime') {
          const validationImport = path.node.specifiers
            ? path.node.specifiers.find(
                s =>
                  s.type === 'ImportSpecifier' &&
                  s.imported.type === 'Identifier' &&
                  s.imported.name === 'Validation'
              )
            : null
          if (validationImport) {
            const newValidationImport = templates.importValidation({
              LOCAL: validationImport.local,
            }) as any

            newValidationImport.importKind =
              (validationImport.type === 'ImportSpecifier'
                ? validationImport.importKind
                : null) || path.node.importKind
            path.insertAfter(newValidationImport)
          }
          moveLeadingCommentsToNextSibling(path)
          path.remove()
        }
      },
    })
  }

  async replaceReifyCall(
    path: NodePath<t.TypeCastExpression> | NodePath<t.TSAsExpression>
  ): Promise<void> {
    const reifiedType = getReifiedType(path)
    if (!reifiedType) return
    if (reifiedType.isGenericTypeAnnotation()) {
      const genType = reifiedType as NodePath<t.GenericTypeAnnotation>
      const convertedUtility = await convertUtilityFlowType(this, genType)
      if (convertedUtility) {
        path.replaceWith(convertedUtility)
        return
      }
    }
    if (
      reifiedType.isGenericTypeAnnotation() ||
      reifiedType.isTSTypeReference()
    ) {
      try {
        const { converted, kind } = await this.convertTypeReference(
          reifiedType.isGenericTypeAnnotation()
            ? (reifiedType as NodePath<t.GenericTypeAnnotation>).get('id')
            : (reifiedType as NodePath<t.TSTypeReference>).get('typeName')
        )

        const { parentPath } = path
        if (kind !== 'class' && parentPath.isVariableDeclarator()) {
          const { id } = parentPath.node as t.VariableDeclarator
          if (id.type === 'Identifier' && areReferencesEqual(converted, id)) {
            parentPath.remove()
            return
          }
        }
        path.replaceWith(
          await this.convertTypeReferenceToValidator({ converted, kind })
        )
        return
      } catch (error) {
        // ignore
      }
    }
    path.replaceWith(await this.convert(reifiedType))
  }

  importT = once(
    async (): Promise<t.Identifier> => {
      const ast = await this.parseFile(this.file)
      let program: NodePath<t.Program> | undefined
      let lastImport: NodePath<t.ImportDeclaration> | undefined
      traverse(ast, {
        Program: (path: NodePath<t.Program>) => {
          program = path
        },
        ImportDeclaration: (path: NodePath<t.ImportDeclaration>) => {
          lastImport = path
        },
      })
      const T = t.identifier(this.context.t.name)
      if (lastImport)
        lastImport.insertAfter(templates.importTypedValidators({ T }) as any)
      else if (program)
        program.unshiftContainer(
          'body',
          templates.importTypedValidators({ T }) as any
        )
      return T
    }
  )

  async convertExport(name: string): Promise<ConvertedTypeReference> {
    const ast = await this.parseFile(this.file)
    let pathToConvert: NodePath<any> | undefined
    if (name === 'default') {
      traverse(ast, {
        ExportDefaultDeclaration: (
          path: NodePath<t.ExportDefaultDeclaration>
        ) => {
          const declaration = path.get('declaration')
          const node: any = declaration.node
          if (node) {
            path.stop()
            pathToConvert = declaration
          }
        },
        ExportSpecifier: (path: NodePath<t.ExportSpecifier>) => {
          if (getKey(path.node.exported) === 'default') {
            path.stop()
            pathToConvert = path.get('local')
          }
        },
      })
    } else if (name === '*') {
      throw new Error('TODO')
    } else {
      traverse(ast, {
        ExportNamedDeclaration: (path: NodePath<t.ExportNamedDeclaration>) => {
          const declaration = path.get('declaration')
          const node: any = declaration.node
          if (node?.id && getKey(node.id) === name) {
            path.stop()
            pathToConvert = declaration
          }
        },
        ExportSpecifier: (path: NodePath<t.ExportSpecifier>) => {
          if (getKey(path.node.exported) === name) {
            path.stop()
            pathToConvert = path.get('exported')
          }
        },
      })
    }
    if (!pathToConvert)
      throw new Error(`export ${name} not found in file: ${this.file}`)
    const result = await this.convertTypeReference(pathToConvert)
    if (
      pathToConvert.parentPath.isExportDefaultDeclaration() &&
      result.kind === 'alias'
    ) {
      const exported = this.getValidatorIdentifier('default')
      if (result.converted.type !== 'Identifier') {
        throw new NodeConversionError(
          `need converted export to be an identifier`,
          this.file,
          pathToConvert
        )
      }
      pathToConvert.parentPath.insertAfter(
        t.exportNamedDeclaration(null, [
          t.exportSpecifier(result.converted, exported),
        ])
      )
      return { converted: exported, kind: result.kind }
    }
    if (
      pathToConvert.parentPath.isExportSpecifier() &&
      result.kind === 'alias'
    ) {
      const exportTypeSpecifier = pathToConvert.parentPath
        .node as t.ExportSpecifier
      if (result.converted.type !== 'Identifier') {
        throw new NodeConversionError(
          `need converted export to be an identifier`,
          this.file,
          pathToConvert
        )
      }
      const exported =
        getKey(exportTypeSpecifier.exported) === 'default'
          ? this.getValidatorIdentifier('default')
          : result.converted
      pathToConvert.parentPath.parentPath.insertAfter(
        t.exportNamedDeclaration(null, [
          t.exportSpecifier(result.converted, exported),
        ])
      )
      if (getKey(exportTypeSpecifier.exported) === 'default')
        return { converted: exported, kind: result.kind }
    }
    return result
  }

  async convertTypeReference(
    path: NodePath<any>
  ): Promise<ConvertedTypeReference> {
    let converted = this.convertedTypeReferences.get(path.node)
    if (converted) return converted
    converted = await this._convertTypeReference(path)
    this.convertedTypeReferences.set(path.node, converted)
    return converted
  }

  private async _convertTypeReference(
    path: NodePath<any>
  ): Promise<ConvertedTypeReference> {
    const type = path.node
    switch (type.type) {
      case 'Identifier': {
        const id = path as NodePath<t.Identifier>
        id.scope.path.traverse(TSBindingVisitors)
        const binding = id.scope.getBinding(id.node.name)
        if (binding) return await this.convertTypeReference(binding.path)
        if (builtinClasses.has(id.node.name))
          return { converted: id.node, kind: 'class' }
        break
      }
      case 'ClassDeclaration':
        return { converted: type.id, kind: 'class' }
      case 'TypeAlias': {
        const { id } = type as t.TypeAlias
        const T = await this.importT()
        const validatorId = this.getValidatorIdentifier(id)
        const validatorIdWithType = this.getValidatorIdentifier(id)
        validatorIdWithType.typeAnnotation = t.typeAnnotation(
          t.genericTypeAnnotation(
            t.qualifiedTypeIdentifier(t.identifier('TypeAlias'), T),
            t.typeParameterInstantiation([t.genericTypeAnnotation(id)])
          )
        )
        const validator: t.VariableDeclaration = templates.alias({
          T,
          ID: validatorIdWithType,
          NAME: t.stringLiteral(id.name),
          TYPE: await this.convert(
            (path as NodePath<t.TypeAlias>).get('right')
          ),
        }) as any

        const { parentPath } = path
        if (parentPath.isExportNamedDeclaration())
          parentPath.insertAfter(t.exportNamedDeclaration(validator))
        else path.insertAfter(validator)
        return { converted: validatorId, kind: 'alias' }
      }
      case 'TSTypeAliasDeclaration': {
        const { id } = type as t.TSTypeAliasDeclaration
        const T = await this.importT()
        const validatorId = this.getValidatorIdentifier(id)
        const validatorIdWithType = this.getValidatorIdentifier(id)
        validatorIdWithType.typeAnnotation = t.tsTypeAnnotation(
          t.tsTypeReference(
            t.tsQualifiedName(T, t.identifier('TypeAlias')),
            t.tsTypeParameterInstantiation([t.tsTypeReference(id)])
          )
        )

        const validator: t.VariableDeclaration = templates.alias({
          T,
          ID: validatorIdWithType,
          NAME: t.stringLiteral(id.name),
          TYPE: await this.convert(
            (path as NodePath<t.TSTypeAliasDeclaration>).get('typeAnnotation')
          ),
        }) as any
        const { parentPath } = path
        if (parentPath.isExportNamedDeclaration())
          parentPath.insertAfter(t.exportNamedDeclaration(validator))
        else path.insertAfter(validator)
        return { converted: validatorId, kind: 'alias' }
      }
      case 'ImportDefaultSpecifier':
      case 'ImportSpecifier': {
        const specifier = type as t.ImportSpecifier | t.ImportDefaultSpecifier
        const importDeclaration = path.parentPath as NodePath<
          t.ImportDeclaration
        >
        const { local } = specifier
        const imported =
          specifier.type === 'ImportDefaultSpecifier'
            ? t.identifier('default')
            : specifier.imported
        const importKind =
          (specifier.type === 'ImportSpecifier'
            ? specifier.importKind
            : null) ||
          importDeclaration.node.importKind ||
          'value'
        const source = importDeclaration.node.source.value
        if (!source) {
          throw new NodeConversionError(
            `Expected import to have source`,
            this.file,
            importDeclaration
          )
        }
        if (!source.startsWith('.')) {
          // eslint-disable-next-line no-console
          console.error(
            new NodeConversionError(
              `WARNING: import from dependencies will be typed as any`,
              this.file,
              path
            ).message
          )
          return { converted: t.identifier('any'), kind: 'any' }
        }
        const sourceFile = await resolveImportSource(
          this.context.resolve,
          this.file,
          importDeclaration
        )
        const sourceContext = this.context.forFile(sourceFile)
        const { converted, kind } = await sourceContext.convertExport(
          getKey(imported)
        )
        if (kind === 'any') return { converted, kind }
        if (
          converted.type !== 'Identifier' &&
          converted.type !== 'StringLiteral'
        ) {
          throw new NodeConversionError(
            `expected converted export to be an Identifier or StringLiteral, but got ${converted.type}`,
            this.file,
            path
          )
        }
        const id = kind === 'class' ? local : this.getValidatorIdentifier(local)
        if (importKind === 'type' || !areReferencesEqual(imported, converted)) {
          const finalPath =
            path.isImportDefaultSpecifier() && kind !== 'class'
              ? (path.replaceWith(
                  t.importSpecifier(specifier.local, t.identifier('default'))
                )[0] as NodePath<
                  | t.ImportDefaultSpecifier
                  | t.ImportSpecifier
                  | t.ImportNamespaceSpecifier
                >)
              : path
          const finalSpecifier = finalPath.node
          moveImportKindToSpecifiers(importDeclaration.node)
          if (kind === 'class') finalSpecifier.importKind = 'value'
          else finalPath.insertAfter(t.importSpecifier(id, converted))
        }
        return { converted: id, kind }
      }
    }
    throw new NodeConversionError(`Unsupported type reference`, this.file, path)
  }

  async convertTypeReferenceToValidator({
    converted,
    kind,
  }: ConvertedTypeReference): Promise<t.Expression> {
    return kind === 'class'
      ? templates.instanceOf({ T: await this.importT(), CLASS: converted })
      : kind === 'alias'
      ? templates.ref({ T: await this.importT(), TYPE: converted })
      : templates.any({ T: await this.importT() })
  }

  async convert(path: NodePath<any>): Promise<t.Expression> {
    const type = path.node
    switch (type.type) {
      case 'MixedTypeAnnotation':
      case 'TSUnknownKeyword':
        return templates.unknown({ T: await this.importT() })
      case 'AnyTypeAnnotation':
      case 'TSAnyKeyword':
        return templates.any({ T: await this.importT() })
      case 'VoidTypeAnnotation':
      case 'TSVoidKeyword':
      case 'TSUndefinedKeyword':
        return templates.undefined({ T: await this.importT() })
      case 'NullLiteralTypeAnnotation':
      case 'TSNullKeyword':
        return templates.null({ T: await this.importT() })
      case 'NumberTypeAnnotation':
      case 'TSNumberKeyword':
        return templates.number({ T: await this.importT() })
      case 'StringTypeAnnotation':
      case 'TSStringKeyword':
        return templates.string({ T: await this.importT() })
      case 'BooleanTypeAnnotation':
      case 'TSBooleanKeyword':
        return templates.boolean({ T: await this.importT() })
      case 'SymbolTypeAnnotation':
      case 'TSSymbolKeyword':
        return templates.symbol({ T: await this.importT() })
      case 'NumberLiteralTypeAnnotation':
        return Object.assign(
          templates.numberLiteral({
            T: await this.importT(),
            VALUE: t.numericLiteral(type.value),
          }) as t.CallExpression,
          { typeParameters: t.typeParameterInstantiation([type]) }
        )
      case 'StringLiteralTypeAnnotation':
        return Object.assign(
          templates.stringLiteral({
            T: await this.importT(),
            VALUE: t.stringLiteral(type.value),
          }) as t.CallExpression,
          { typeParameters: t.typeParameterInstantiation([type]) }
        )
      case 'BooleanLiteralTypeAnnotation':
        return Object.assign(
          templates.booleanLiteral({
            T: await this.importT(),
            VALUE: t.booleanLiteral(type.value),
          }) as t.CallExpression,
          { typeParameters: t.typeParameterInstantiation([type]) }
        )
      case 'TSLiteralType':
        switch (type.literal.type) {
          case 'StringLiteral':
            return templates.stringLiteral({
              T: await this.importT(),
              VALUE: type.literal,
            })
          case 'NumericLiteral':
            return templates.numberLiteral({
              T: await this.importT(),
              VALUE: type.literal,
            })
          case 'BooleanLiteral':
            return templates.booleanLiteral({
              T: await this.importT(),
              VALUE: type.literal,
            })
        }
        break
      case 'NullableTypeAnnotation':
        return templates.nullishOr({
          T: await this.importT(),
          TYPE: await this.convert(
            (path as NodePath<t.NullableTypeAnnotation>).get('typeAnnotation')
          ),
        })
      case 'ArrayTypeAnnotation':
        return templates.array({
          T: await this.importT(),
          TYPE: await this.convert(
            (path as NodePath<t.ArrayTypeAnnotation>).get('elementType')
          ),
        })
      case 'TSArrayType':
        return templates.array({
          T: await this.importT(),
          TYPE: await this.convert(
            (path as NodePath<t.TSArrayType>).get('elementType')
          ),
        })
      case 'TupleTypeAnnotation':
        return templates.tuple({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.TupleTypeAnnotation>)
              .get('types')
              .map(type => this.convert(type))
          ),
        })
      case 'TSTupleType':
        return templates.tuple({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.TSTupleType>)
              .get('elementTypes')
              .map(type => this.convert(type))
          ),
        })
      case 'TSNamedTupleMember':
        return this.convert(
          (path as NodePath<t.TSNamedTupleMember>).get('elementType')
        )
      case 'UnionTypeAnnotation':
        return templates.oneOf({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.UnionTypeAnnotation>)
              .get('types')
              .map(type => this.convert(type))
          ),
        })
      case 'TSUnionType':
        return templates.oneOf({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.TSUnionType>)
              .get('types')
              .map(type => this.convert(type))
          ),
        })
      case 'IntersectionTypeAnnotation':
        return templates.allOf({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.IntersectionTypeAnnotation>)
              .get('types')
              .map(type => this.convert(type))
          ),
        })
      case 'TSIntersectionType':
        return templates.allOf({
          T: await this.importT(),
          TYPES: await Promise.all(
            (path as NodePath<t.TSIntersectionType>)
              .get('types')
              .map(type => this.convert(type))
          ),
        })
      case 'ObjectTypeAnnotation':
        return await convertObjectTypeAnnotation(
          this,
          path as NodePath<t.ObjectTypeAnnotation>
        )
      case 'TSTypeLiteral':
        return await convertTSTypeLiteral(
          this,
          path as NodePath<t.TSTypeLiteral>
        )
      case 'GenericTypeAnnotation': {
        const convertedUtility = await convertUtilityFlowType(this, path)
        if (convertedUtility) return convertedUtility
        return await this.convertTypeReferenceToValidator(
          await this.convertTypeReference(
            (path as NodePath<t.GenericTypeAnnotation>).get('id')
          )
        )
      }
      case 'TSTypeReference': {
        if (isTSRecordType(path)) return await convertTSRecordType(this, path)
        return await this.convertTypeReferenceToValidator(
          await this.convertTypeReference(
            (path as NodePath<t.TSTypeReference>).get('typeName')
          )
        )
      }
    }
    throw new NodeConversionError(`Unsupported type`, this.file, path)
  }
}
