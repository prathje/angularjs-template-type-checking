angular.module('poc').controller('Students', [
    '$scope',
    /** @param {ng.IScope & StudentsScope} $scope */
    function ($scope) {
        $scope.students = [
            { id: 1, first_name: 'Anna', last_name: 'Muster', email: 'anna@example.com', birthdate: '2007-03-01', lessons_taken: 4 },
            { id: 2, first_name: 'Luca', last_name: 'Beispiel', email: null, birthdate: '2006-11-23', lessons_taken: 11 },
        ];
        $scope.selected = null;
        $scope.editing = false;
        $scope.search = '';

        $scope.select = function (student) {
            $scope.selected = student;
        };

        $scope.remove = function (student) {
            $scope.students = $scope.students.filter(function (s) { return s !== student; });
            if ($scope.selected === student) {
                $scope.selected = null;
            }
        };

        $scope.startEditing = function () {
            // BUG (JS side): the contract says `editing: boolean`
            $scope.editing = 'yes';
        };
    },
]);
