# CGuard

**한국어** | [English](README.en.md)

CGuard는 C 소스 코드의 오류를 찾아 **파일의 해당 위치와 VS Code Problems 패널**에 원인과 수정 방법을 표시합니다. 소스는 현재 VS Code 프로세스에서 정적으로 검사합니다.

## 사용 방법

1. [GitHub 릴리스](https://github.com/leekmny/CGuard/releases/tag/v0.1.1)의 VSIX 파일을 내려받아 데스크톱 VS Code(1.95 이상)의 **Extensions: Install from VSIX...** 명령으로 설치한 뒤 로컬 `.c` 파일을 엽니다.
2. 파일을 열거나 저장하면 CGuard가 검사합니다. 명령 팔레트의 **CGuard: Check Current C File**로 현재 편집 내용을 바로 검사할 수 있습니다.
3. 문제가 표시된 줄에서 메시지를 읽고 코드를 수정한 뒤 검사 결과를 다시 확인합니다.

CGuard는 Tree-sitter의 C 문법을 WebAssembly로 사용하고, TypeScript로 작성한 검사 규칙의 결과를 VS Code 진단으로 전달합니다. 문법 오류와 같은 파일에서 확실히 판정할 수 있는 오류를 검사합니다. 지원할 수 있는 소스 크기는 512 KiB입니다.

- 파서가 인식한 C 문법 오류의 위치를 표시합니다.
- 크기와 인덱스가 정수 리터럴로 주어진 배열 접근의 범위를 검사합니다. 크기가 생략된 호환 재선언에서도 같은 배열의 앞선 크기를 사용합니다.
- 가변 길이 배열(VLA)의 크기 식과, 결과 계산에 피연산자 평가가 필요한 일부 `sizeof` 식을 검사합니다. 정수 리터럴 조건과 단순한 `_Generic` 선택으로 건너뛸 피연산자를 구분합니다. 실행 조건을 확정할 수 없는 곳에서는 해당 접근이 평가될 때의 인덱스 오류를 표시합니다.
- 동일 블록에서 초기화 없이 선언한 단순 지역 스칼라를 곧바로 반환하는 패턴을 검사합니다.

전처리 조건, 매크로 확장, 동적 인덱스, 포인터 별칭 및 여러 파일을 넘나드는 데이터 흐름은 현재 검사 범위 밖입니다. 동적 배열 크기의 값이나 전체 C 타입을 추론하지 않으므로, 타입을 확인해야 선택되는 `_Generic` 분기와 복합 타입의 VLA `sizeof`는 건너뛸 수 있습니다.

## 개발과 독립 테스트

```powershell
npm ci --ignore-scripts
npm test
npm run package -- --out cguard.vsix
node tests/vscode/run.cjs cguard.vsix
```

독립 테스트는 실제 VS Code 데스크톱을 새 사용자 데이터와 확장 디렉터리로 열어 패키지를 설치합니다. 오류 예제의 줄·메시지, 정상 파일의 결과, 오류 수정 후 진단 제거, 크기가 생략된 배열 재선언의 진단을 검증합니다. 설치된 VS Code 실행 파일의 경로를 지정하려면 `CGUARD_VSCODE_PATH`를 설정합니다. `CGUARD_QA_OUTPUT`에는 결과 JSON을 저장할 경로를 지정할 수 있습니다.
