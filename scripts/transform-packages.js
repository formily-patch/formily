// scripts/transform-packages.js
const fs = require('fs')
const path = require('path')
const glob = require('glob')
const { execSync } = require('child_process')

class PackageTransformer {
  constructor() {
    this.publishPackages = this.parsePublishPackages()
    this.commitHash = process.env.COMMIT_HASH || this.getCommitHash()
    this.enableGenerateSummary = process.env.GENERATE_SUMMARY === 'true'

    this.transformedPackages = []

    console.log(`📋 要转换的包: ${this.publishPackages.join(', ')}`)
    console.log(`🔖 Commit Hash: ${this.commitHash}`)
  }

  // 解析要发布的包列表
  parsePublishPackages() {
    const defaultPackages = [
      '@formily/core',
      '@formily/react',
      '@formily/path',
      '@formily/reactive',
      '@formily/validator',
      '@formily/shared',
      '@formily/reactive-react',
      '@formily/json-schema',
    ]
    const packages = process.env.PUBLISH_PACKAGES || defaultPackages.join(',')
    return packages
      .split(',')
      .map((pkg) => pkg.trim())
      .filter(Boolean)
  }

  // 获取 commit hash
  getCommitHash() {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    } catch (error) {
      console.warn('Warning: Could not get commit hash, using timestamp')
      return Date.now().toString(36)
    }
  }

  // 转换包名：@formily/core -> @formily-patch/core
  transformPackageName(originalName) {
    return originalName.replace('@formily/', '@formily-patch/')
  }

  // 转换版本号：2.37.0 -> 2.37.0-patch.abc123
  transformVersion(originalVersion) {
    const baseVersion = originalVersion.split('-')[0]
    return `${baseVersion}-patch.${this.commitHash}`
  }

  // 获取包的目录路径
  getPackageDir(packageName) {
    const packageShortName = packageName.replace('@formily/', '')
    return path.resolve(`packages/${packageShortName}`)
  }

  // 替换文件内容中的包名引用
  replacePackageReferences(filePath, packageMappings) {
    if (!fs.existsSync(filePath)) {
      return false
    }

    let content = fs.readFileSync(filePath, 'utf8')
    let changed = false

    for (const [oldName, newName] of Object.entries(packageMappings)) {
      // 匹配各种引用方式
      const patterns = [
        // import/export 语句: from '@formily/core'
        new RegExp(`(['"\`])${this.escapeRegExp(oldName)}\\1`, 'g'),
        // package.json 中的依赖
        new RegExp(`"${this.escapeRegExp(oldName)}"`, 'g'),
      ]

      for (const pattern of patterns) {
        if (content.includes(oldName)) {
          const newContent = content.replace(pattern, (match, quote) => {
            return quote ? `${quote}${newName}${quote}` : `"${newName}"`
          })

          if (newContent !== content) {
            content = newContent
            changed = true
          }
        }
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8')
      return true
    }

    return false
  }

  // 转义正则表达式特殊字符
  escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // 转换 package.json 中的依赖
  transformDependencies(dependencies, packageMappings) {
    if (!dependencies) return dependencies

    const transformed = {}
    for (const [name, version] of Object.entries(dependencies)) {
      if (packageMappings[name]) {
        // 转换内部依赖
        const newName = packageMappings[name]
        const newVersion = this.transformVersion(version)
        transformed[newName] = newVersion
      } else {
        // 保持外部依赖不变
        transformed[name] = version
      }
    }
    return transformed
  }

  // 转换单个包
  transformPackage(originalPackageName) {
    const packageDir = this.getPackageDir(originalPackageName)
    const packageJsonPath = path.join(packageDir, 'package.json')

    if (!fs.existsSync(packageJsonPath)) {
      console.warn(`⚠️  包不存在: ${originalPackageName} (${packageDir})`)
      return null
    }

    console.log(`🔧 转换包: ${originalPackageName}`)

    // 读取原始 package.json
    const originalPkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

    // 创建包名映射
    const packageMappings = {}
    for (const pkg of this.publishPackages) {
      packageMappings[pkg] = this.transformPackageName(pkg)
    }

    // 1. 转换 package.json
    const transformedPkg = {
      ...originalPkg,
      name: this.transformPackageName(originalPkg.name),
      version: this.transformVersion(originalPkg.version),
      dependencies: this.transformDependencies(
        originalPkg.dependencies,
        packageMappings
      ),
      devDependencies: this.transformDependencies(
        originalPkg.devDependencies,
        packageMappings
      ),
      peerDependencies: this.transformDependencies(
        originalPkg.peerDependencies,
        packageMappings
      ),
    }

    // 更新描述
    const originalDescription = originalPkg.description || ''
    transformedPkg.description = `${originalDescription} (Patched version of ${originalPkg.name}@${originalPkg.version})`

    // 保存转换后的 package.json
    fs.writeFileSync(packageJsonPath, JSON.stringify(transformedPkg, null, 2))

    // 2. 转换源代码文件
    this.transformSourceFiles(packageDir, packageMappings)

    // 3. 更新 README.md 文件，添加 compareUrl 信息
    this.updateReadmeFile(packageDir, originalPkg.name, transformedPkg.name, transformedPkg.version)

    const transformedInfo = {
      original: originalPackageName,
      transformed: transformedPkg.name,
      version: transformedPkg.version,
      path: packageDir,
    }

    this.transformedPackages.push(transformedInfo)

    console.log(
      `✅ 转换完成: ${originalPackageName} -> ${transformedPkg.name}@${transformedPkg.version}`
    )

    return transformedInfo
  }

  // 转换源代码文件
  transformSourceFiles(packageDir, packageMappings) {
    console.log(`🔍 转换源代码: ${packageDir}`)

    // 查找所有需要转换的文件
    const filePatterns = [`${packageDir}/src/**/*.{js,ts,jsx,tsx}`]

    const sourceFiles = []
    for (const pattern of filePatterns) {
      sourceFiles.push(...glob.sync(pattern))
    }

    let changedFiles = 0
    for (const filePath of sourceFiles) {
      if (this.replacePackageReferences(filePath, packageMappings)) {
        changedFiles++
      }
    }

    console.log(`📝 修改了 ${changedFiles} 个文件`)
  }

  // 生成对比 URL
  generateCompareUrl() {
    return `https://github.com/alibaba/formily/compare/formily_next...formily-patch:formily:${this.commitHash}`
  }

  //更新 README.md 文件
  updateReadmeFile(packageDir, originalName, transformedName, transformedVersion) {
    const readmePath = path.join(packageDir, 'README.md')

    if (!fs.existsSync(readmePath)) {
      console.log(`📝 README.md 不存在，跳过: ${packageDir}`)
      return
    }

    let content = fs.readFileSync(readmePath, 'utf8')
    const compareUrl = this.generateCompareUrl()

    // 替换标题中的包名
    content = content.replace(new RegExp(`^# ${this.escapeRegExp(originalName)}`, 'm'), `# ${transformedName}`)

    // 在文件开头添加补丁信息
    const patchInfo = `# ${transformedName}
  
  > 🔧 **这是一个 Formily 的补丁版本**
  > 
  > - **原始包**: ${originalName}
  > - **补丁版本**: ${transformedVersion}
  > - **变更对比**: [查看变更](${compareUrl})
  > - **提交哈希**: ${this.commitHash}
  
  ---
  
  `

    // 移除原有的标题行，然后添加新的补丁信息
    content = content.replace(/^# .*$/m, '').replace(/^\n+/, '')
    content = patchInfo + content

    fs.writeFileSync(readmePath, content, 'utf8')
    console.log(`📝 已更新 README.md: ${readmePath}`)
  }

  // 生成转换摘要
  generateSummary() {
    const compareUrl = this.generateCompareUrl()

    const packageTable = this.transformedPackages
      .map((pkg) => `| ${pkg.original} | ${pkg.transformed} | ${pkg.version} |`)
      .join('\n')

    const installCommands = this.transformedPackages
      .map((pkg) => `npm install ${pkg.transformed}@${pkg.version}`)
      .join('\n')

    const importExamples = this.transformedPackages
      .map(
        (pkg) =>
          `// ${pkg.original} -> ${pkg.transformed}\n- import { ... } from '${pkg.original}'\n+ import { ... } from '${pkg.transformed}'`
      )
      .join('\n\n')

    const summary = `# Package Transformation Summary

## Compare URL
${compareUrl}

## Transformed Packages
| Original Package | New Package | Version |
|------------------|-------------|---------|
${packageTable}

## Installation
\`\`\`bash
${installCommands}
\`\`\`

## Migration Guide
\`\`\`diff
${importExamples}
\`\`\`

## Details
- **Commit**: ${this.commitHash}
- **Transform Time**: ${new Date().toISOString()}
- **Total Packages**: ${this.transformedPackages.length}
`

    fs.writeFileSync('transform-summary.md', summary)
    console.log('📄 转换摘要已生成: transform-summary.md')
  }

  // 主执行函数
  async run() {
    console.log('🚀 开始包转换...')

    try {
      // 转换所有指定的包
      for (const packageName of this.publishPackages) {
        this.transformPackage(packageName)
      }

      if (this.transformedPackages.length === 0) {
        console.log('⚠️  没有找到要转换的包')
        return
      }

      // 生成摘要
      if (this.enableGenerateSummary) {
        this.generateSummary()
      }

      console.log(
        `🎉 转换完成! 共转换了 ${this.transformedPackages.length} 个包`
      )

      // 输出转换结果
      console.log('\n📦 转换结果:')
      for (const pkg of this.transformedPackages) {
        console.log(`   ${pkg.original} -> ${pkg.transformed}@${pkg.version}`)
      }
    } catch (error) {
      console.error('💥 转换失败:', error)
      process.exit(1)
    }
  }
}

// 主执行
async function main() {
  const transformer = new PackageTransformer()
  await transformer.run()
}

main().catch((error) => {
  console.error('Script failed:', error)
  process.exit(1)
})
